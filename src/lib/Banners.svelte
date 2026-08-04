<script lang="ts" module>
export type BannerItem = {
  /** Stable identity for dismissal. */
  id: number;
  /** The banner sentence. */
  text: string;
  /** Affected vault-relative paths, listed under the sentence. */
  paths?: string[];
  /** Optional review action; the label is the shared review string. */
  onReview?: () => void;
  /** Uses the polite status channel instead of the assertive alert channel. */
  polite?: boolean;
};
</script>

<script lang="ts">
import { STRINGS } from "./strings";

let {
  banners,
  onDismiss,
}: {
  banners: BannerItem[];
  onDismiss: (id: number) => void;
} = $props();
</script>

{#each banners as banner (banner.id)}
  <aside
    class="skr-warning flex items-start gap-2 border-b px-3 py-1.5 text-xs"
    role={banner.polite ? "status" : "alert"}
    aria-live={banner.polite ? "polite" : undefined}
  >
    <div class="min-w-0 flex-1">
      <p class="m-0">{banner.text}</p>
      {#if banner.paths !== undefined && banner.paths.length > 0}
        <ul class="m-0 list-none p-0">
          {#each banner.paths as path (path)}
            <li class="truncate font-mono">{path}</li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if banner.onReview !== undefined}
      <button
        type="button"
        class="skr-btn-secondary shrink-0"
        data-btn-role="secondary"
        onclick={banner.onReview}
      >
        {STRINGS.reviewAction}
      </button>
    {/if}
    <button
      type="button"
      class="skr-btn-secondary shrink-0"
      data-btn-role="secondary"
      onclick={() => onDismiss(banner.id)}
    >
      {STRINGS.dismissAction}
    </button>
  </aside>
{/each}
