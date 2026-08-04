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
  maximizeButtonRectFromDomRect,
  minimizeWindow,
  readWindowChromeState,
  reportMaximizeButtonRect,
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

// Named `chromeState`, not `state`: Svelte's compiler disambiguates the
// `$state` rune from its own legacy `$storeName` auto-subscription syntax
// by checking for a same-named local variable, and a variable literally
// named `state` collides with the rune name itself once a second `$state`
// call exists anywhere in the component, breaking type inference on both.
let chromeState = $state<WindowChromeState>(DEFAULT_WINDOW_CHROME_STATE);

// Windows-only native hit-testing for the Maximize button (design system
// section 4.13): the button's own DOM element, and the hover and press
// state the native side mirrors back once it starts answering
// `WM_NCHITTEST` for that area, since real pointer events stop reaching the
// webview there and the button's own CSS `:hover`/`:active` never fire.
let maximizeButtonEl: HTMLButtonElement | null = $state(null);
let maximizeButtonHovered = $state(false);
let maximizeButtonPressed = $state(false);

/** Reports the Maximize button's current rectangle, or clears the report
 * when it is not meaningfully on screen (narrow viewport, before mount, a
 * platform other than Windows). Keeping the native side in sync here is
 * what makes Windows 11 snap layouts track the button's real position
 * rather than wherever it used to be. */
function syncMaximizeButtonRect(): void {
  if (platform !== "windows" || narrowViewport || maximizeButtonEl === null) {
    void reportMaximizeButtonRect(null);
    return;
  }
  void reportMaximizeButtonRect(
    maximizeButtonRectFromDomRect(
      maximizeButtonEl.getBoundingClientRect(),
      window.devicePixelRatio,
    ),
  );
}

$effect(() => {
  syncMaximizeButtonRect();
});

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
  applyChromeVariables(!narrowViewport, chromeState);
});

onMount(() => {
  if (platform === null) return;

  let disposed = false;
  let unsubscribeChromeState: (() => void) | null = null;

  void readWindowChromeState().then((initial) => {
    if (disposed) return;
    chromeState = initial;
  });
  void subscribeWindowChromeState((next) => {
    if (!disposed) chromeState = { ...chromeState, ...next };
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

  // Windows-only: the button's screen position shifts whenever the window
  // resizes (it sits at the header's trailing edge), even when its own
  // size never changes, so a plain `resize` listener is what keeps the
  // native hit-test rectangle from drifting out from under the pointer.
  const unlistenMaximizeButtonHitState =
    platform === "windows"
      ? events.maximizeButtonHitState.listen((event) => {
          maximizeButtonHovered = event.payload.hovered;
          maximizeButtonPressed = event.payload.pressed;
        })
      : null;
  if (platform === "windows") {
    window.addEventListener("resize", syncMaximizeButtonRect);
  }

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
      chromeState = { ...chromeState, ...next };
    };
  }

  return () => {
    disposed = true;
    unsubscribeChromeState?.();
    void unlistenMenu.then((dispose) => dispose());
    if (platform === "windows") {
      window.removeEventListener("resize", syncMaximizeButtonRect);
      void unlistenMaximizeButtonHitState?.then((dispose) => dispose());
      void reportMaximizeButtonRect(null);
    }
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

/** Captures the Maximize button's own DOM node into `maximizeButtonEl`.
 * `bind:this` cannot target a conditional expression inside the `#each`
 * below, so this Svelte action does the same job for the one button in the
 * loop that needs it. */
function bindMaximizeButtonRef(node: HTMLButtonElement, isMaximize: boolean) {
  if (isMaximize) maximizeButtonEl = node;
  return {
    destroy() {
      if (isMaximize && maximizeButtonEl === node) maximizeButtonEl = null;
    },
  };
}
</script>

{#if platform !== null && !narrowViewport && showsCaptionButtons(platform)}
  <div class="skr-window-controls" data-testid="window-controls">
    {#each CAPTION_BUTTON_ORDER as id (id)}
      <button
        type="button"
        class="skr-caption-button"
        class:skr-caption-button-close={id === "close"}
        class:skr-caption-button-native-hover={id === "maximize" &&
          maximizeButtonHovered}
        class:skr-caption-button-native-active={id === "maximize" &&
          maximizeButtonPressed}
        data-testid="caption-{id}"
        aria-label={CAPTION_LABELS[id]}
        onclick={() => runCaptionButton(id)}
        use:bindMaximizeButtonRef={id === "maximize"}
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
    /* Caption buttons are edge controls and bleed to the window edge; the
       section 5.12 radius scale does not apply (section 4.13, the one
       named exemption). */
    border-radius: 0;
    padding: 0;
    background: transparent;
    color: var(--skr-text-muted);
    transition:
      color var(--skr-motion-state-duration) var(--skr-motion-state-easing),
      background-color var(--skr-motion-state-duration)
        var(--skr-motion-state-easing);
  }

  .skr-caption-button:hover,
  /* Windows native hit-testing (design system section 4.13) routes real
     pointer input over the Maximize button away from the webview once it
     starts answering `WM_NCHITTEST` for that area, so this button's own
     `:hover` never fires there; the native side mirrors its hover and
     press state back over an event instead, applied as these two classes. */
  .skr-caption-button-native-hover,
  .skr-caption-button-native-active {
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
