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
    class="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs"
    role="alert"
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
        class="shrink-0 rounded border border-amber-400 px-2 py-0.5 outline-offset-1 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-blue-500"
        onclick={banner.onReview}
      >
        {STRINGS.reviewAction}
      </button>
    {/if}
    <button
      type="button"
      class="shrink-0 rounded border border-amber-400 px-2 py-0.5 outline-offset-1 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-blue-500"
      onclick={() => onDismiss(banner.id)}
    >
      {STRINGS.dismissAction}
    </button>
  </aside>
{/each}
