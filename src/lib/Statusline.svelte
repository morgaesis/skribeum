<script lang="ts">
// registry-exempt keydown: Escape closing the note-info and failure
// popovers is ARIA dialog pattern internal dismissal, not a command.
import { commandTooltip } from "./commandTooltip";
import {
  type EditorStatistics,
  formatLastEdited,
  formatLineColumn,
  formatWordCount,
  type PersistenceState,
} from "./features/noteStatistics";
import { enterMotionSurface } from "./motion";
import NoteInfo from "./NoteInfo.svelte";
import { STRINGS } from "./strings";

let {
  path,
  createdMs,
  modifiedMs,
  statistics,
  sourceMode = false,
  persistence = { kind: "saved" },
  announcement = null,
  infoOpen = $bindable(false),
}: {
  /** Vault-relative path of the open note, or null with none open. */
  path: string | null;
  createdMs?: number | null;
  modifiedMs?: number | null;
  statistics?: EditorStatistics | null;
  sourceMode?: boolean;
  persistence?: PersistenceState;
  /** The transient center-slot announcement of section 6.2. */
  announcement?: { id: number; text: string } | null;
  /** Whether the note-info popover is open (also command-driven). */
  infoOpen?: boolean;
} = $props();

const ANNOUNCEMENT_VISIBLE_MS = 2000;

let nowMs = $state(Date.now());
let announcementText = $state<string | null>(null);
let announcementExiting = $state(false);
let announcementTimer: ReturnType<typeof setTimeout> | undefined;
let failureOpen = $state(false);
let editedSegment = $state<HTMLButtonElement | undefined>();
let barElement = $state<HTMLElement | undefined>();

const lastEdited = $derived(
  path !== null && modifiedMs !== null && modifiedMs !== undefined
    ? formatLastEdited(modifiedMs, nowMs)
    : null,
);

// Minute-granularity relative text stays honest with a half-minute tick.
$effect(() => {
  const interval = setInterval(() => {
    nowMs = Date.now();
  }, 30_000);
  return () => clearInterval(interval);
});

// Section 6.2: the announcement clears after two seconds, leaving with the
// 50ms state-class opacity fade of section 5.1.
$effect(() => {
  const current = announcement;
  clearTimeout(announcementTimer);
  if (current === null) {
    announcementText = null;
    announcementExiting = false;
    return;
  }
  announcementText = current.text;
  announcementExiting = false;
  announcementTimer = setTimeout(() => {
    announcementExiting = true;
    announcementTimer = setTimeout(() => {
      announcementText = null;
      announcementExiting = false;
    }, 80);
  }, ANNOUNCEMENT_VISIBLE_MS);
  return () => clearTimeout(announcementTimer);
});

$effect(() => {
  if (path === null) {
    infoOpen = false;
    failureOpen = false;
  }
});

function closeSurfaces(restoreFocus: boolean) {
  const wasOpen = infoOpen;
  infoOpen = false;
  failureOpen = false;
  if (restoreFocus && wasOpen) {
    editedSegment?.focus();
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && (infoOpen || failureOpen)) {
    event.preventDefault();
    closeSurfaces(true);
  }
}

function onWindowPointerdown(event: PointerEvent) {
  if (!infoOpen && !failureOpen) return;
  const target = event.target;
  if (target instanceof Node && barElement?.contains(target) === true) {
    return;
  }
  closeSurfaces(false);
}

function surfaceEnter(node: HTMLElement) {
  enterMotionSurface(node);
}
</script>

<svelte:window
  onkeydown={onWindowKeydown}
  onpointerdown={onWindowPointerdown}
/>

<footer
  class="skr-statusline"
  aria-label={STRINGS.statuslineLabel}
  data-testid="statusline"
  bind:this={barElement}
>
  <div class="skr-statusline-leading">
    {#if lastEdited !== null}
      <button
        type="button"
        class="skr-statusline-segment"
        aria-haspopup="dialog"
        aria-expanded={infoOpen}
        data-testid="statusline-edited"
        bind:this={editedSegment}
        use:commandTooltip={{ title: STRINGS.commandNoteStatistics }}
        onclick={() => {
          failureOpen = false;
          infoOpen = !infoOpen;
        }}
      >
        {lastEdited}
      </button>
    {/if}
    {#if infoOpen}
      <div
        class="skr-statusline-popover"
        role="dialog"
        aria-label={STRINGS.noteInfoLabel}
        data-motion-surface="anchored-bottom"
        data-testid="note-info-popover"
        use:surfaceEnter
      >
        <NoteInfo
          {path}
          createdMs={createdMs ?? null}
          modifiedMs={modifiedMs ?? null}
          statistics={statistics ?? null}
        />
      </div>
    {/if}
  </div>

  <div
    class="skr-statusline-center"
    aria-live="polite"
    data-testid="statusline-announcements"
  >
    {#if announcementText !== null}
      <span
        class="skr-statusline-announcement"
        class:skr-statusline-announcement-exiting={announcementExiting}
      >
        {announcementText}
      </span>
    {/if}
  </div>

  <div class="skr-statusline-trailing">
    {#if path !== null && sourceMode && statistics !== null && statistics !== undefined}
      <span class="skr-statusline-fact" data-testid="statusline-line-column">
        {formatLineColumn(statistics.line, statistics.column)}
      </span>
    {/if}
    {#if path !== null && statistics !== null && statistics !== undefined}
      <span class="skr-statusline-fact" data-testid="statusline-word-count">
        {formatWordCount(statistics.words, statistics.selectionWords)}
      </span>
    {/if}
    {#if path !== null && persistence.kind === "saving"}
      <span class="skr-statusline-fact" data-testid="statusline-persistence">
        {STRINGS.statuslineSaving}
      </span>
    {:else if path !== null && persistence.kind === "failed"}
      <button
        type="button"
        class="skr-statusline-segment skr-statusline-danger"
        aria-haspopup="dialog"
        aria-expanded={failureOpen}
        data-testid="statusline-persistence"
        use:commandTooltip={{ title: STRINGS.statuslineSaveFailed }}
        onclick={() => {
          infoOpen = false;
          failureOpen = !failureOpen;
        }}
      >
        {STRINGS.statuslineSaveFailed}
      </button>
      {#if failureOpen && persistence.kind === "failed"}
        <div
          class="skr-statusline-popover skr-statusline-popover-trailing"
          role="dialog"
          aria-label={STRINGS.statuslineSaveFailed}
          data-motion-surface="anchored-bottom"
          data-testid="save-failure-detail"
          use:surfaceEnter
        >
          <p class="skr-statusline-failure-heading">
            {STRINGS.statuslineSaveFailedDetail}
          </p>
          <p class="skr-statusline-failure-message">{persistence.message}</p>
        </div>
      {/if}
    {/if}
  </div>
</footer>

<style>
  /* Section 4.16 geometry: 1.5rem, full width, below everything, quiet. */
  .skr-statusline {
    position: relative;
    display: flex;
    box-sizing: border-box;
    height: 1.5rem;
    flex: none;
    align-items: center;
    border-top: 1px solid var(--skr-border);
    padding-inline: 0.5rem;
    background: var(--skr-surface);
    color: var(--skr-text-muted);
    font-family: var(--skr-font-interface);
    font-size: 12px;
  }

  .skr-statusline-leading,
  .skr-statusline-trailing {
    position: relative;
    display: flex;
    min-width: 0;
    height: 100%;
    flex: 1;
    align-items: center;
    gap: 0.25rem;
  }

  .skr-statusline-trailing {
    justify-content: flex-end;
  }

  .skr-statusline-center {
    display: flex;
    overflow: hidden;
    min-width: 0;
    flex: none;
    justify-content: center;
    white-space: nowrap;
  }

  .skr-statusline-announcement {
    opacity: 1;
    transition: opacity var(--skr-motion-state-duration)
      var(--skr-motion-state-easing);
  }

  .skr-statusline-announcement-exiting {
    opacity: 0;
  }

  /* Flat text segments per section 5.12: interactive ones take the hover
     fill at the control radius, nothing carries a border or a box. */
  .skr-statusline-segment {
    display: inline-flex;
    align-items: center;
    border: 0;
    border-radius: var(--skr-radius-control);
    padding: 0.0625rem 0.375rem;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: background-color var(--skr-motion-state-duration)
      var(--skr-motion-state-easing);
  }

  .skr-statusline-segment:hover {
    background: var(--skr-surface-subtle);
  }

  .skr-statusline-segment:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }

  .skr-statusline-fact {
    padding-inline: 0.375rem;
    white-space: nowrap;
  }

  .skr-statusline-danger {
    color: var(--skr-danger);
  }

  .skr-statusline-popover {
    position: absolute;
    z-index: 60;
    bottom: calc(100% + 0.375rem);
    left: 0;
    min-width: 16rem;
    max-width: 24rem;
    border: 1px solid var(--skr-border);
    border-radius: var(--skr-radius-surface);
    padding: 0.625rem 0.75rem;
    background: var(--skr-surface-raised);
    box-shadow: var(--skr-shadow);
  }

  .skr-statusline-popover-trailing {
    right: 0;
    left: auto;
  }

  .skr-statusline-failure-heading {
    margin: 0 0 0.25rem;
    color: var(--skr-text-muted);
    font-size: 12px;
  }

  .skr-statusline-failure-message {
    overflow-wrap: anywhere;
    margin: 0;
    color: var(--skr-text);
    font-size: 13px;
  }
</style>
