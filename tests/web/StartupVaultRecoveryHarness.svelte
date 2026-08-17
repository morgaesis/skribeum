<script lang="ts">
import StartupVaultRecovery from "../../src/lib/StartupVaultRecovery.svelte";
import type { StartupVaultSurface } from "../../src/lib/startupVaultRecovery";

let { initialSurface }: { initialSurface: StartupVaultSurface } = $props();
let surface = $state<StartupVaultSurface | undefined>();

$effect(() => {
  surface ??= initialSurface;
});

export function setSurface(nextSurface: StartupVaultSurface): void {
  surface = nextSurface;
}
</script>

{#if surface !== undefined}
  <StartupVaultRecovery {surface} onOpen={() => {}} />
{/if}
