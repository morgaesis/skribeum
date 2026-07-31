<script lang="ts">
import Skribeum from "../src/App.svelte";
import { DEMO_INITIAL_NOTE } from "./lib/vault/seed";

let noticeVisible = $state(true);

if (typeof window !== "undefined") {
  const demoWindow = window as Window & {
    __SKRIBEUM_E2E_NOTE__?: string;
    __SKRIBEUM_E2E_VAULT__?: string;
  };
  demoWindow.__SKRIBEUM_E2E_VAULT__ = "skribeum-demo";
  demoWindow.__SKRIBEUM_E2E_NOTE__ = DEMO_INITIAL_NOTE;
}
</script>

<div class="demo-shell">
  {#if noticeVisible}
    <aside class="demo-notice" aria-label="Browser demo notice">
      <div class="demo-notice__copy">
        <p>
          This is a browser demo of the Skribeum editor surface. The product is
          the desktop application where files on disk are the source of truth.
          <a href="https://github.com/morgaesis/skribeum/releases"
            >Download the desktop app</a
          >.
        </p>
        <p>Edits here live only in browser memory and are lost on reload.</p>
      </div>
      <button
        type="button"
        class="demo-notice__dismiss"
        aria-label="Dismiss browser demo notice"
        onclick={() => {
          noticeVisible = false;
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </aside>
  {/if}
  <div class="demo-app">
    <Skribeum />
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

  .demo-notice {
    position: relative;
    z-index: 20;
    display: flex;
    flex: none;
    align-items: flex-start;
    gap: 1rem;
    border-bottom: 1px solid var(--skr-border);
    padding: 0.65rem 0.8rem 0.7rem 1rem;
    background: var(--skr-warning-surface);
    color: var(--skr-warning);
    box-shadow: 0 1px 0 rgb(15 23 42 / 5%);
    font-size: 0.8125rem;
    line-height: 1.45;
  }

  .demo-notice__copy {
    min-width: 0;
    flex: 1;
  }

  .demo-notice p {
    margin: 0;
  }

  .demo-notice p + p {
    margin-top: 0.2rem;
    font-weight: 600;
  }

  .demo-notice a {
    color: inherit;
    font-weight: 700;
    text-underline-offset: 0.16em;
  }

  .demo-notice__dismiss {
    display: grid;
    width: 2rem;
    height: 2rem;
    flex: none;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 1.35rem;
    line-height: 1;
  }

  .demo-notice__dismiss:hover {
    border-color: color-mix(in srgb, currentColor 35%, transparent);
    background: color-mix(in srgb, currentColor 8%, transparent);
  }

  .demo-notice__dismiss:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 1px;
  }

  .demo-app {
    min-height: 0;
    flex: 1;
  }

  .demo-app > :global(.h-screen) {
    height: 100%;
  }

  @media (max-width: 42rem) {
    .demo-notice {
      padding-left: 0.75rem;
      font-size: 0.75rem;
    }
  }
</style>
