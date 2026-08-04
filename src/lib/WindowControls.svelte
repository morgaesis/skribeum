<script lang="ts">
// The desktop window layer (design system section 4.13): Windows and Linux
// caption buttons, the native macOS menu bar's dispatch back into the
// command registry, and the window-state-driven CSS custom properties the
// header and window shell read for the unfocused dim, the border and
// radius, and the macOS leading inset. Renders nothing outside the desktop
// runtime or on the narrow (phone-shell) layout, which owns its own chrome
// per section 4.7 and section 4.13's own scope note.
import { onMount } from "svelte";
import { events } from "./ipc/bindings";
import type { CommandRegistry } from "./registry/registry";
import type { CommandContext } from "./registry/types";
import { STRINGS } from "./strings";
import {
  CAPTION_BUTTON_ORDER,
  type CaptionButtonId,
  closeWindowChrome,
  DEFAULT_WINDOW_CHROME_STATE,
  type DesktopPlatform,
  desktopPlatform,
  headerForegroundOpacity,
  linuxWindowRadiusRem,
  macosLeadingInsetRem,
  minimizeWindow,
  readWindowChromeState,
  showsCaptionButtons,
  showsWindowBorder,
  subscribeWindowChromeState,
  toggleMaximizeWindow,
  type WindowChromeState,
} from "./windowChrome";

type Props = {
  registry: CommandRegistry;
  commandContext: () => CommandContext;
  narrowViewport: boolean;
};

const { registry, commandContext, narrowViewport }: Props = $props();

const platform: DesktopPlatform | null = desktopPlatform();

let state = $state<WindowChromeState>(DEFAULT_WINDOW_CHROME_STATE);

/** Applies the window-chrome CSS custom properties the header and the
 * `.skr-shell` root read. Neutral values on the narrow layout, whose own
 * chrome (section 4.7) this section does not touch. */
function applyChromeVariables(active: boolean, current: WindowChromeState) {
  const root = document.documentElement.style;
  if (!active || platform === null) {
    root.setProperty("--skr-window-header-inset", "0rem");
    root.setProperty("--skr-window-header-opacity", "1");
    root.setProperty("--skr-window-border-width", "0px");
    root.setProperty("--skr-window-border-radius", "0rem");
    return;
  }
  const inset =
    platform === "macos" ? macosLeadingInsetRem(current.fullscreen, 0) : 0;
  root.setProperty("--skr-window-header-inset", `${inset}rem`);
  root.setProperty(
    "--skr-window-header-opacity",
    String(headerForegroundOpacity(current.focused)),
  );
  root.setProperty(
    "--skr-window-border-width",
    showsWindowBorder(current) ? "1px" : "0px",
  );
  root.setProperty(
    "--skr-window-border-radius",
    `${linuxWindowRadiusRem(platform, current)}rem`,
  );
}

$effect(() => {
  applyChromeVariables(!narrowViewport, state);
});

onMount(() => {
  if (platform === null) return;

  let disposed = false;
  let unsubscribeChromeState: (() => void) | null = null;

  void readWindowChromeState().then((initial) => {
    if (disposed) return;
    state = initial;
  });
  void subscribeWindowChromeState((next) => {
    if (!disposed) state = next;
  }).then((dispose) => {
    if (disposed) {
      dispose();
      return;
    }
    unsubscribeChromeState = dispose;
  });

  // Native macOS menu bar items registered against a command registry id
  // (see `src-tauri/src/menu.rs`) dispatch here, so the menu never
  // reimplements a command the registry already owns.
  const unlistenMenu = events.menuCommandInvoked.listen((event) => {
    registry.run(event.payload.command, commandContext());
  });

  // The end-to-end suite cannot force genuine OS focus loss or a native
  // maximize from inside the same WebDriver session it drives, so it feeds
  // synthetic transitions through the exact state path a real window event
  // would take (see `readWindowChromeState`), following the existing
  // `__SKRIBEUM_E2E_*` debug-hook convention (`src/App.svelte`).
  const debugWindow = window as Window & {
    __SKRIBEUM_E2E_VAULT__?: string;
    __SKRIBEUM_E2E_SET_WINDOW_CHROME__?: (
      next: Partial<WindowChromeState>,
    ) => void;
  };
  if (typeof debugWindow.__SKRIBEUM_E2E_VAULT__ === "string") {
    debugWindow.__SKRIBEUM_E2E_SET_WINDOW_CHROME__ = (next) => {
      state = { ...state, ...next };
    };
  }

  return () => {
    disposed = true;
    unsubscribeChromeState?.();
    void unlistenMenu.then((dispose) => dispose());
    applyChromeVariables(false, DEFAULT_WINDOW_CHROME_STATE);
    delete debugWindow.__SKRIBEUM_E2E_SET_WINDOW_CHROME__;
  };
});

const CAPTION_LABELS: Record<CaptionButtonId, string> = {
  minimize: STRINGS.windowMinimize,
  maximize: STRINGS.windowMaximizeOrRestore,
  close: STRINGS.windowClose,
};

function runCaptionButton(id: CaptionButtonId): void {
  if (id === "minimize") void minimizeWindow();
  else if (id === "maximize") void toggleMaximizeWindow();
  else void closeWindowChrome();
}
</script>

{#if platform !== null && !narrowViewport && showsCaptionButtons(platform)}
  <div class="skr-window-controls" data-testid="window-controls">
    {#each CAPTION_BUTTON_ORDER as id (id)}
      <button
        type="button"
        class="skr-caption-button"
        class:skr-caption-button-close={id === "close"}
        data-testid="caption-{id}"
        aria-label={CAPTION_LABELS[id]}
        onclick={() => runCaptionButton(id)}
      >
        {#if id === "minimize"}
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 5h8" />
          </svg>
        {:else if id === "maximize"}
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" />
          </svg>
        {:else}
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1l8 8M9 1l-8 8" />
          </svg>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  /* Caption buttons are edge controls that bleed to the window edge; the
     section 5.12 radius scale explicitly does not apply to them. */
  .skr-window-controls {
    display: flex;
    flex: none;
    height: 2.5rem;
    margin-inline-start: 0.5rem;
  }

  .skr-caption-button {
    display: grid;
    place-items: center;
    width: 2.875rem;
    height: 100%;
    border: 0;
    border-radius: 0;
    padding: 0;
    background: transparent;
    color: var(--skr-text-muted);
    transition:
      color var(--skr-motion-state-duration) var(--skr-motion-state-easing),
      background-color var(--skr-motion-state-duration)
        var(--skr-motion-state-easing);
  }

  .skr-caption-button:hover {
    background-color: var(--skr-surface-subtle);
  }

  .skr-caption-button-close:hover {
    background-color: var(--skr-danger);
    color: var(--skr-surface);
  }

  .skr-caption-button svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1;
  }

  .skr-caption-button-close svg {
    stroke-width: 1.25;
  }
</style>
