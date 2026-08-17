<script lang="ts">
// The standalone image surface.
//
// Safety posture, identical to an image embedded in a note: the bytes are
// handed to an `<img>` element and to nothing else, so a vector image loads
// in the user agent's secure static mode, where scripts, event handlers,
// external references and interactivity are all disabled. The media type
// comes from the caller's extension allowlist, never from the file's own
// content, so a payload cannot choose the type it is served as and can
// never reach the webview as a document.

import { onMount } from "svelte";
import { enterMotionSurface } from "../motion";
import { STRINGS } from "../strings";

let {
  bytes,
  mediaType,
  fileName,
}: {
  /** The file's exact vault bytes. */
  bytes: Uint8Array;
  /** The media type the file extension grants. */
  mediaType: string;
  /** The file name, used as the image's accessible name. */
  fileName: string;
} = $props();

// `bind:this` writes `null` back when the element is torn down, so the
// reference is nullable and every reader checks it.
let surface: HTMLDivElement | null = null;
let url = $state<string | null>(null);
let failed = $state(false);

$effect(() => {
  const objectUrl = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: mediaType }),
  );
  url = objectUrl;
  failed = false;
  return () => {
    URL.revokeObjectURL(objectUrl);
    url = null;
  };
});

onMount(() => {
  enterMotionSurface(surface);
});
</script>

<div
  bind:this={surface}
  class="skr-image-view"
  data-testid="image-view"
  data-motion-surface="fade"
  data-media-type={mediaType}
>
  {#if url !== null && !failed}
    <img
      class="skr-image-view-frame"
      data-testid="image-view-frame"
      src={url}
      alt={fileName}
      decoding="async"
      onerror={() => (failed = true)}
    />
  {:else if failed}
    <p class="skr-image-view-unavailable" role="alert">
      {STRINGS.imageUnavailable}
    </p>
  {/if}
  <p class="skr-image-view-caption">{fileName}</p>
</div>

<style>
  .skr-image-view {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    box-sizing: border-box;
    height: 100%;
    padding: clamp(1rem, 4vh, 2rem) var(--skr-gutter);
    overflow: auto;
  }

  .skr-image-view-frame {
    max-width: 100%;
    /* Room for the caption below stays reserved, so a tall image scales
       rather than pushing its own name out of the pane. */
    max-height: calc(100% - 2rem);
    border-radius: 0.375rem;
    object-fit: contain;
    /* A transparent raster or vector image reads against a known surface
       instead of whatever happens to be behind the pane. */
    background: var(--skr-surface-subtle);
  }

  .skr-image-view-caption {
    margin: 0;
    color: var(--skr-text-muted);
    font-family: var(--skr-font-interface);
    font-size: 0.8125rem;
  }

  .skr-image-view-unavailable {
    margin: 0;
    color: var(--skr-text-muted);
    font-family: var(--skr-font-interface);
    font-size: 0.875rem;
  }
</style>
