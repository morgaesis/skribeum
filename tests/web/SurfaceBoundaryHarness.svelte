<script lang="ts">
import SurfaceBoundary from "../../src/lib/SurfaceBoundary.svelte";
import FailingSurface from "./FailingSurface.svelte";

/** One boundaried panel beside an ordinary interactive part of the shell. */
let { label, shouldFail = false }: { label: string; shouldFail?: boolean } =
  $props();

let clicks = $state(0);
</script>

<SurfaceBoundary {label}>
  <FailingSurface {shouldFail} />
</SurfaceBoundary>

<button type="button" data-testid="elsewhere" onclick={() => (clicks += 1)}>
  {clicks}
</button>
