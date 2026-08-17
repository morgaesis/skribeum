<script lang="ts">
import type { Snippet } from "svelte";
import { STRINGS } from "./strings";

/**
 * A containment boundary around one panel of the shell.
 *
 * An error thrown while Svelte is updating a component (a render pass or an
 * `$effect`) destroys every effect above it that cannot handle it, which for
 * an unguarded application means the whole reactive graph stops: no further
 * render, no further event handling, no message. A boundary confines that to
 * the panel it wraps. The panel is replaced in place by the product's shared
 * failure treatment, which offers to rebuild it, and every other surface in
 * the shell keeps rendering and keeps responding.
 *
 * The boundary is deliberately local. It reports the failure it caught on the
 * console and never registers a global handler, so uncaught errors from
 * outside the component tree still reach whatever the host installed.
 */
let {
  label,
  children,
}: {
  /** Names the failing panel in the console record and in the DOM. */
  label: string;
  children: Snippet;
} = $props();

function report(error: unknown): void {
  console.error(`Surface failed: ${label}`, error);
}
</script>

<svelte:boundary onerror={report}>
  {@render children()}

  {#snippet failed(_error: unknown, reset: () => void)}
    <div class="skr-surface-failure" role="alert" data-surface-failure={label}>
      <span class="skr-loading-failure-message">{STRINGS.couldNotLoad}</span>
      <button type="button" class="skr-loading-retry" onclick={reset}>
        {STRINGS.retryAction}
      </button>
    </div>
  {/snippet}
</svelte:boundary>

<style>
  .skr-surface-failure {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.65rem;
    border-left: 3px solid var(--skr-danger);
    background: var(--skr-surface-subtle);
  }
</style>
