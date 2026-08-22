<script lang="ts">
// The pane's no-note surface (design spec sections 10-17): "No note is
// open" when the vault has notes and none is open here, "This vault is
// empty" when it has none. Never editable: no CodeMirror instance, no
// contenteditable element, anywhere in this component.
import { tick } from "svelte";
import { ASYNC_SKELETON_DELAY_MS } from "./loadingStates";
import { enterMotionSurface } from "./motion";
import { STRINGS } from "./strings";

export type EmptyPaneAction = {
  id: string;
  label: string;
  keybinding?: string;
};

export type EmptyPaneRecentRow = {
  path: string;
  title: string;
  suffix?: string;
  relativeTime: string;
};

let {
  hasNotes,
  actions,
  recent,
  takeFocus,
  instant,
  onRunCommand,
  onOpenRecent,
}: {
  /** Whether the vault holds at least one note (state A) or none (state B). */
  hasNotes: boolean;
  /** New note, Find a note, Search note text, in that order. */
  actions: readonly EmptyPaneAction[];
  /** At most five rows, already ordered and capped by the caller. */
  recent: readonly EmptyPaneRecentRow[];
  /**
   * Bumped identity claims focus for the primary action on mount (design
   * spec section 16.1): the session's first painted frame, or an act that
   * removed focus from this pane's contents. Any other mount leaves focus
   * where it was.
   */
  takeFocus: boolean;
  /** True only for the session's first painted frame: arrives with no
   * separate entrance animation (section 17's instant list). */
  instant: boolean;
  onRunCommand: (id: string) => void;
  onOpenRecent: (path: string, newTab: boolean) => void;
} = $props();

const uid = $props.id();
const headingId = `skr-empty-pane-heading-${uid}`;

let root = $state<HTMLElement>();
let primaryButton = $state<HTMLButtonElement>();

// Section 15: the surface renders only once the listing has "resolved".
// In this shell the vault's note listing is already resolved by the time
// this component exists (the vault-open gate covers that latency), so the
// gate below settles on the next microtask in production and is exercised
// with a real delay only by the debug hook the end-to-end probe sets.
function listingDelayMs(): number {
  const debugWindow = window as Window & {
    __SKRIBEUM_E2E_EMPTY_PANE_LISTING_DELAY_MS__?: number;
  };
  return debugWindow.__SKRIBEUM_E2E_EMPTY_PANE_LISTING_DELAY_MS__ ?? 0;
}

const initialDelay = listingDelayMs();
let resolved = $state(initialDelay <= 0);
let showPlaceholder = $state(false);

$effect(() => {
  if (initialDelay <= 0) return;
  let settled = false;
  const placeholderTimer = setTimeout(() => {
    if (!settled) showPlaceholder = true;
  }, ASYNC_SKELETON_DELAY_MS);
  const resolveTimer = setTimeout(() => {
    settled = true;
    resolved = true;
  }, initialDelay);
  return () => {
    settled = true;
    clearTimeout(placeholderTimer);
    clearTimeout(resolveTimer);
  };
});

// Section 17: the empty state fades in (120ms, opacity only) arriving after
// a note closes, and arrives with no separate animation at all at the
// session's first painted frame (`data-motion-instant`, section 17's
// instant list; the CSS rule pins opacity to 1 with a 0ms transition).
$effect(() => {
  enterMotionSurface(root);
});

function bindPrimary(node: HTMLButtonElement, isPrimary: boolean) {
  if (isPrimary) primaryButton = node;
  return {
    destroy() {
      if (primaryButton === node) primaryButton = undefined;
    },
  };
}

// Section 16.3: a programmatic focus move onto the primary action always
// renders its ring, whatever input modality preceded it, because the
// product moved focus, not the reader.
function forceFocusRing(node: HTMLButtonElement) {
  node.dataset.forceFocusRing = "true";
  const clear = () => delete node.dataset.forceFocusRing;
  node.addEventListener("blur", clear, { once: true });
}

$effect(() => {
  if (!takeFocus || !resolved) return;
  void tick().then(() => {
    if (primaryButton === undefined || !primaryButton.isConnected) return;
    primaryButton.focus({ preventScroll: true });
    forceFocusRing(primaryButton);
  });
});

// Mirrors the file tree's own open-target convention exactly (Mod-click and
// middle-click both add a tab; a plain click opens in place), so a note
// opened from here follows the same two routes as every other
// note-opening surface (design spec section 12.5).
function openRecent(event: MouseEvent, path: string) {
  onOpenRecent(path, event.ctrlKey || event.metaKey);
}

function openRecentAux(event: MouseEvent, path: string) {
  if (event.button !== 1) return;
  event.preventDefault();
  onOpenRecent(path, true);
}
</script>

<div
  bind:this={root}
  class="skr-empty-pane"
  data-motion-surface="fade"
  data-motion-entered="false"
  data-motion-instant={instant ? "true" : undefined}
>
  {#if !resolved}
    {#if showPlaceholder}
      <div class="skr-empty-pane-column skr-empty-pane-loading" role="status" aria-label={STRINGS.emptyPaneLoading}>
        <span class="skr-skeleton-bar" style="width: 100%"></span>
        <span class="skr-skeleton-bar" style="width: 62%"></span>
        <span class="skr-skeleton-bar" style="width: 44%"></span>
      </div>
    {/if}
  {:else if hasNotes}
    <section class="skr-empty-pane-column" aria-labelledby={headingId}>
      <h1 id={headingId} class="skr-empty-pane-heading">{STRINGS.noNoteOpenHeading}</h1>
      <div class="skr-empty-pane-actions">
        {#each actions as action, index (action.id)}
          <button
            type="button"
            class="skr-empty-pane-action"
            data-btn-role={index === 0 ? "primary" : "secondary"}
            data-command-id={action.id}
            use:bindPrimary={index === 0}
            onclick={() => onRunCommand(action.id)}
          >
            <span>{action.label}</span>
            {#if action.keybinding !== undefined}
              <kbd>{action.keybinding}</kbd>
            {/if}
          </button>
        {/each}
      </div>
      {#if recent.length > 0}
        <div class="skr-empty-pane-recent">
          <h2 class="skr-panel-heading skr-empty-pane-recent-label uppercase tracking-wide font-semibold">
            {STRINGS.commandSurfaceRecent}
          </h2>
          <ul class="skr-empty-pane-recent-list">
            {#each recent as row (row.path)}
              <li>
                <button
                  type="button"
                  class="skr-empty-pane-recent-row"
                  data-recent-path={row.path}
                  onclick={(event) => openRecent(event, row.path)}
                  onauxclick={(event) => openRecentAux(event, row.path)}
                >
                  <span class="skr-empty-pane-recent-title">
                    {row.title}
                    {#if row.suffix !== undefined}
                      <span class="skr-empty-pane-recent-suffix">{row.suffix}</span>
                    {/if}
                  </span>
                  <span class="skr-empty-pane-recent-time">{row.relativeTime}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>
  {:else}
    <section class="skr-empty-pane-column" aria-labelledby={headingId}>
      <h1 id={headingId} class="skr-empty-pane-heading">{STRINGS.emptyVaultHeading}</h1>
      <p class="skr-empty-pane-body">{STRINGS.emptyVaultBody}</p>
      <div class="skr-empty-pane-actions">
        {#each actions.slice(0, 1) as action (action.id)}
          <button
            type="button"
            class="skr-empty-pane-action"
            data-btn-role="primary"
            data-command-id={action.id}
            use:bindPrimary={true}
            onclick={() => onRunCommand(action.id)}
          >
            <span>{action.label}</span>
            {#if action.keybinding !== undefined}
              <kbd>{action.keybinding}</kbd>
            {/if}
          </button>
        {/each}
      </div>
    </section>
  {/if}
</div>
