// Desktop window chrome (design system section 4.13): platform detection
// and the pure per-platform layout and state decisions the header and the
// window-controls component render from, plus thin wrappers around the
// Tauri window API. The decision functions are plain and fully unit
// tested; the platform branches only a real window can exercise (macOS
// traffic lights and native fullscreen, Windows 11 snap layouts) still need
// a session on that platform, noted where each is used.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { hasDesktopRuntime } from "./features/updates";
import type { MaximizeButtonRect } from "./ipc/bindings";
import {
  windowSetMaximizeButtonRect,
  windowShowSystemMenu,
} from "./ipc/services";

/** The three desktop platforms Skribeum draws window chrome for. The
 * browser build never reaches this module's rendering paths. */
export type DesktopPlatform = "macos" | "windows" | "linux";

/** Fixed caption button order (design system section 4.13): identical on
 * Windows and Linux. The desktop environment's own button-order or layout
 * preference is never read. */
export const CAPTION_BUTTON_ORDER = ["minimize", "maximize", "close"] as const;

export type CaptionButtonId = (typeof CAPTION_BUTTON_ORDER)[number];

/** Reported window chrome state, refreshed from the native window on
 * resize and focus-change events. */
export type WindowChromeState = {
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
};

export const DEFAULT_WINDOW_CHROME_STATE: WindowChromeState = {
  maximized: false,
  fullscreen: false,
  focused: true,
};

/**
 * Classifies the desktop platform from a webview user agent string. Pure
 * and platform-independent, so it is exercised directly in unit tests on
 * every CI runner; the platform-conditional rendering it drives (traffic
 * lights on macOS, caption buttons on Windows and Linux) still needs a
 * session on the platform in question to confirm the native chrome it
 * approximates matches.
 */
export function platformFromUserAgent(userAgent: string): DesktopPlatform {
  if (/mac os x|macintosh/i.test(userAgent)) return "macos";
  if (/windows/i.test(userAgent)) return "windows";
  return "linux";
}

/** The active desktop platform, or `null` outside the desktop runtime; the
 * browser build keeps the browser's chrome and never renders window
 * chrome (design system section 4.13). */
export function desktopPlatform(): DesktopPlatform | null {
  if (!hasDesktopRuntime()) return null;
  return platformFromUserAgent(navigator.userAgent);
}

/** Windows and Linux draw caption buttons; macOS keeps the native traffic
 * lights and never draws its own. */
export function showsCaptionButtons(platform: DesktopPlatform): boolean {
  return platform !== "macos";
}

/**
 * The leading inset in rem that clears the macOS traffic lights (design
 * system section 4.13): 5.5rem normally, the caller's ordinary base inset
 * once native fullscreen auto-hides the traffic lights. Exact traffic-light
 * geometry is set by the platform config (`trafficLightPosition` in
 * `src-tauri/tauri.macos.conf.json`) and needs a real macOS session to
 * confirm the derived vertical centering lands correctly.
 */
export function macosLeadingInsetRem(
  fullscreen: boolean,
  baseInsetRem: number,
): number {
  return fullscreen ? baseInsetRem : 5.5;
}

/** Whether the window shows its own 1px border and, on Linux, corner
 * radius: unmaximized and not fullscreen (design system section 4.13). */
export function showsWindowBorder(state: WindowChromeState): boolean {
  return !state.maximized && !state.fullscreen;
}

/** Linux corner radius in rem for the current state; 0 elsewhere, because
 * Windows 11 and macOS round the window through the compositor. */
export function linuxWindowRadiusRem(
  platform: DesktopPlatform,
  state: WindowChromeState,
): number {
  return platform === "linux" && showsWindowBorder(state) ? 0.5 : 0;
}

/** Header foreground opacity while the window is unfocused (design system
 * section 4.13, a state-class transition per section 5.1); note content
 * never dims. */
export function headerForegroundOpacity(focused: boolean): number {
  return focused ? 1 : 0.6;
}

/** Reads the current maximized, fullscreen and focus state from the native
 * window. Resolves to the unfocused-safe default outside the desktop
 * runtime, so callers never need a separate guard. */
export async function readWindowChromeState(): Promise<WindowChromeState> {
  if (!hasDesktopRuntime()) return DEFAULT_WINDOW_CHROME_STATE;
  const window = getCurrentWindow();
  const [maximized, fullscreen, focused] = await Promise.all([
    window.isMaximized(),
    window.isFullscreen(),
    window.isFocused(),
  ]);
  return { maximized, fullscreen, focused };
}

/** A resize sequence delivers many intermediate events while the pointer or
 * the OS animates the change; maximized and fullscreen are discrete,
 * infrequent transitions, not per-frame feedback, so re-reading them waits
 * for the sequence to settle rather than round-tripping on every event. */
const RESIZE_SETTLE_MS = 150;

/**
 * Subscribes to native window resize and focus-change events, calling
 * `onChange` with the fields that changed. A resize can only change
 * maximized or fullscreen state, so only those two are re-read (never
 * focus, and only after the resize settles); a focus change already
 * carries its new value in the event payload, so it costs no round trip
 * at all. Returns an unsubscribe function; a no-op unsubscribe is
 * returned outside the desktop runtime.
 */
export async function subscribeWindowChromeState(
  onChange: (next: Partial<WindowChromeState>) => void,
): Promise<() => void> {
  if (!hasDesktopRuntime()) return () => {};
  const window = getCurrentWindow();
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const unlistenResized = await window.onResized(() => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      void Promise.all([window.isMaximized(), window.isFullscreen()]).then(
        ([maximized, fullscreen]) => onChange({ maximized, fullscreen }),
      );
    }, RESIZE_SETTLE_MS);
  });
  const unlistenFocusChanged = await window.onFocusChanged((event) => {
    onChange({ focused: event.payload });
  });
  return () => {
    clearTimeout(settleTimer);
    unlistenResized();
    unlistenFocusChanged();
  };
}

/** Minimizes the window. */
export async function minimizeWindow(): Promise<void> {
  if (!hasDesktopRuntime()) return;
  await getCurrentWindow().minimize();
}

/** Toggles between maximized and restored. On Windows, hovering and holding
 * the button normally reaches this same toggle through the native
 * `WM_NCLBUTTONUP` handler instead (design system section 4.13's snap-layout
 * hit-testing); this click path stays the route on every platform and the
 * one keyboard activation always uses. */
export async function toggleMaximizeWindow(): Promise<void> {
  if (!hasDesktopRuntime()) return;
  await getCurrentWindow().toggleMaximize();
}

/** Closes the window. */
export async function closeWindowChrome(): Promise<void> {
  if (!hasDesktopRuntime()) return;
  await getCurrentWindow().close();
}

/** Shows the drag region's right-click window menu: the real platform
 * system menu on Windows (Move, Size, and the rest `GetSystemMenu`
 * exposes), a predefined-item approximation (Minimize, Maximize or Restore,
 * Close) elsewhere. */
export async function showWindowSystemMenu(): Promise<void> {
  if (!hasDesktopRuntime()) return;
  await windowShowSystemMenu();
}

/** Converts a CSS-pixel `getBoundingClientRect` result into the
 * physical-pixel rectangle Windows native hit-testing expects (design
 * system section 4.13): Chromium reports both the rectangle and
 * `devicePixelRatio` in the same effective scale, monitor DPI times page
 * zoom, so multiplying one by the other lands in the same coordinate space
 * `WM_NCHITTEST` uses after `ScreenToClient`. */
export function maximizeButtonRectFromDomRect(
  domRect: { left: number; top: number; width: number; height: number },
  devicePixelRatio: number,
): MaximizeButtonRect {
  return {
    x: domRect.left * devicePixelRatio,
    y: domRect.top * devicePixelRatio,
    width: domRect.width * devicePixelRatio,
    height: domRect.height * devicePixelRatio,
  };
}

/** Reports the Maximize caption button's rectangle to the native side so
 * Windows hit-testing stays in sync with the webview's own layout and
 * Windows 11 snap layouts appear over the button's real position (design
 * system section 4.13). `null` clears the report. A no-op everywhere except
 * Windows; callers do not need to branch on platform first. */
export async function reportMaximizeButtonRect(
  rect: MaximizeButtonRect | null,
): Promise<void> {
  if (!hasDesktopRuntime()) return;
  await windowSetMaximizeButtonRect(rect);
}
