<script lang="ts">
import { onMount } from "svelte";
import Skribeum from "../src/App.svelte";
import { formatString } from "../src/lib/strings";
import {
  demoVaultStatus,
  localFolderAccessSupported,
  subscribeDemoVaultStatus,
} from "./lib/ipc/vault";
import { DEMO_STRINGS } from "./lib/strings";
import { DEMO_INITIAL_NOTE } from "./lib/vault/seed";

let noticeVisible = $state(true);
let sourceStatus = $state(demoVaultStatus());
const folderAccessSupported = localFolderAccessSupported();
const unsupportedReason = folderAccessSupported
  ? null
  : DEMO_STRINGS.folderAccessUnsupported;
const initialEmptyVaultDemo =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("empty-vault");
let emptyVaultDemo = $state(initialEmptyVaultDemo);
const storageMessage = $derived.by(() => {
  if (sourceStatus.source === "folder") {
    const skipped =
      sourceStatus.skipped === 0
        ? ""
        : formatString(
            sourceStatus.skipped === 1
              ? DEMO_STRINGS.storageSkippedSingular
              : DEMO_STRINGS.storageSkippedPlural,
            { count: sourceStatus.skipped },
          );
    const template =
      sourceStatus.writes === "folder"
        ? DEMO_STRINGS.storageFolderWritable
        : DEMO_STRINGS.storageFolderReadOnly;
    return formatString(template, { name: sourceStatus.name }) + skipped;
  }
  return folderAccessSupported
    ? DEMO_STRINGS.storageSampleSupported
    : DEMO_STRINGS.storageSampleUnsupported;
});

onMount(() => subscribeDemoVaultStatus((next) => (sourceStatus = next)));

if (typeof window !== "undefined") {
  const demoWindow = window as Window & {
    __SKRIBEUM_E2E_NOTE__?: string;
    __SKRIBEUM_E2E_SHOW_EMPTY_VAULT__?: () => void;
    __SKRIBEUM_E2E_VAULT_PICKER_CALLS__?: number;
    __SKRIBEUM_E2E_VAULT__?: string;
  };
  const configureDemoVault = (empty: boolean) => {
    if (empty) {
      delete demoWindow.__SKRIBEUM_E2E_VAULT__;
      delete demoWindow.__SKRIBEUM_E2E_NOTE__;
      demoWindow.__SKRIBEUM_E2E_VAULT_PICKER_CALLS__ = 0;
    } else {
      delete demoWindow.__SKRIBEUM_E2E_VAULT_PICKER_CALLS__;
      demoWindow.__SKRIBEUM_E2E_VAULT__ = "skribeum-demo";
      demoWindow.__SKRIBEUM_E2E_NOTE__ = DEMO_INITIAL_NOTE;
    }
  };
  configureDemoVault(initialEmptyVaultDemo);
  demoWindow.__SKRIBEUM_E2E_SHOW_EMPTY_VAULT__ = () => {
    configureDemoVault(true);
    emptyVaultDemo = true;
  };
}
</script>

<div class="demo-shell">
  {#if noticeVisible}
    <aside
      class="demo-notice"
      aria-label={DEMO_STRINGS.noticeLabel}
      role="status"
      aria-live="polite"
    >
      <div class="demo-notice__copy">
        <p>
          {DEMO_STRINGS.noticeBody}
          <a href="https://github.com/morgaesis/skribeum/releases"
            >{DEMO_STRINGS.downloadDesktopApp}</a
          >.
        </p>
        <p>{storageMessage}</p>
      </div>
      <button
        type="button"
        class="demo-notice__dismiss"
        aria-label={DEMO_STRINGS.dismissNotice}
        onclick={() => {
          noticeVisible = false;
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </aside>
  {/if}
  {#if !noticeVisible}
    <aside class="demo-storage-status" aria-label={DEMO_STRINGS.storageStatusLabel}>
      {storageMessage}
    </aside>
  {/if}
  <div class="demo-app">
    {#key emptyVaultDemo}
      <Skribeum
        openVaultDisabledReason={emptyVaultDemo ? null : unsupportedReason}
        navigationSurface="browser"
      />
    {/key}
  </div>
</div>

<style>
  .demo-shell {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    background: var(--skr-canvas);
  }

  /* Requantified per design system section 4.5: this notice is
     informational, not an alert, so it never outranks the note beneath it.
     A muted, hairline-bounded strip replaces the former full-width amber
     block; the accent tokens match the persistent .demo-storage-status bar
     below so the notice and its post-dismiss successor read as one system. */
  .demo-notice {
    position: relative;
    z-index: 20;
    display: flex;
    flex: none;
    align-items: center;
    gap: 0.75rem;
    border-bottom: 1px solid var(--skr-border);
    padding: 0.375rem 0.5rem 0.375rem 0.75rem;
    background: var(--skr-accent-subtle);
    color: var(--skr-accent);
    font-size: var(--skr-type-label);
    line-height: 1.4;
  }

  .demo-notice__copy {
    min-width: 0;
    flex: 1;
  }

  .demo-notice p {
    margin: 0;
  }

  .demo-notice p + p {
    margin-top: 0.15rem;
  }

  .demo-notice a {
    color: inherit;
    font-weight: 600;
    text-underline-offset: 0.16em;
  }

  .demo-notice__dismiss {
    display: grid;
    width: 2rem;
    height: 2rem;
    flex: none;
    place-items: center;
    border: 0;
    border-radius: var(--skr-radius-control);
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }

  .demo-notice__dismiss:hover {
    background: color-mix(in srgb, currentColor 15%, transparent);
  }

  .demo-notice__dismiss:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 1px;
  }

  .demo-app {
    min-height: 0;
    flex: 1;
  }

  .demo-storage-status {
    flex: none;
    border-bottom: 1px solid var(--skr-border);
    padding: 0.35rem 0.75rem;
    color: var(--skr-accent);
    background: var(--skr-accent-subtle);
    font-size: var(--skr-type-label);
  }

  .demo-app > :global(.h-screen) {
    height: 100%;
  }

  @media (max-width: 60rem) {
    .demo-notice {
      padding-left: 0.75rem;
      font-size: var(--skr-type-label);
    }

    /* The section 4.6 touch-target floor: 2.75rem (44 CSS pixels) in both
       dimensions on narrow viewports, where reachability is the binding
       constraint rather than prominence. */
    .demo-notice__dismiss {
      width: 2.75rem;
      height: 2.75rem;
    }
  }
</style>
