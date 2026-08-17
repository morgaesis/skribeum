<script lang="ts">
import { tick } from "svelte";
import type { StartupVaultSurface } from "./startupVaultRecovery";
import { STRINGS } from "./strings";

let {
  surface,
  onOpen,
  disabledReason = null,
}: {
  surface: StartupVaultSurface;
  onOpen: (path?: string) => void;
  disabledReason?: string | null;
} = $props();

let browseButton = $state<HTMLButtonElement | null>();
let firstRecentButton = $state<HTMLButtonElement>();
let focusedSurface = $state<string | null>(null);

function bindFirstRecent(node: HTMLButtonElement, index: number) {
  if (index === 0) firstRecentButton = node;
  return {
    destroy() {
      if (firstRecentButton === node) firstRecentButton = undefined;
    },
  };
}

$effect(() => {
  const kind = surface.kind;
  const focusKey =
    kind === "chooser"
      ? `${kind}:${surface.rows.map((row) => row.path).join("\u0000")}`
      : kind;
  if (kind === "pending" || focusedSurface === focusKey) return;
  focusedSurface = focusKey;
  void tick().then(() => {
    if (kind === "chooser") {
      const first =
        firstRecentButton ??
        document.querySelector<HTMLButtonElement>("[data-startup-vault-path]");
      first?.focus();
    } else browseButton?.focus();
  });
});
</script>

<div class="skr-empty-vault" data-startup-vault-surface={surface.kind}>
  {#if surface.kind === "pending"}
    <p class="skr-startup-pending" data-testid="startup-pending" role="status">
      {STRINGS.vaultRecoveryPending}
    </p>
  {:else if surface.kind === "chooser"}
    <section class="skr-startup-chooser" aria-labelledby="startup-vault-heading">
      <h1 id="startup-vault-heading">{STRINGS.vaultRecoveryHeading}</h1>
      {#if surface.error !== undefined}
        <p class="skr-startup-error" role="alert">{surface.error}</p>
      {/if}
      <ul class="skr-startup-vault-list" aria-label={STRINGS.vaultRecoveryHeading}>
        {#each surface.rows as row, index (row.path)}
          <li>
            <button
              use:bindFirstRecent={index}
              type="button"
              class="skr-startup-vault-row"
              data-startup-vault-path={row.path}
              aria-label={row.accessibleLabel}
              onclick={() => onOpen(row.path)}
            >
              {row.label}
            </button>
          </li>
        {/each}
      </ul>
      <button
        bind:this={browseButton}
        type="button"
        class="skr-btn-primary"
        disabled={disabledReason !== null}
        title={disabledReason ?? undefined}
        data-command-id="vault.open"
        data-btn-role="primary"
        onclick={() => onOpen()}
      >
        {STRINGS.openVault}
      </button>
    </section>
  {:else}
    <div class="skr-startup-empty">
      {#if surface.error !== undefined}
        <p class="skr-startup-error" role="alert">{surface.error}</p>
      {/if}
      <button
        bind:this={browseButton}
        type="button"
        class="skr-btn-primary"
        disabled={disabledReason !== null}
        title={disabledReason ?? undefined}
        data-command-id="vault.open"
        data-btn-role="primary"
        onclick={() => onOpen()}
      >
        {STRINGS.openVault}
      </button>
      <p class="sr-only">{STRINGS.emptyStateHint}</p>
    </div>
  {/if}
</div>
