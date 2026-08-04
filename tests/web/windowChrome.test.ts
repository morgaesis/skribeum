import { describe, expect, it } from "vitest";
import {
  CAPTION_BUTTON_ORDER,
  headerForegroundOpacity,
  linuxWindowRadiusRem,
  macosLeadingInsetRem,
  maximizeButtonRectFromDomRect,
  platformFromUserAgent,
  showsCaptionButtons,
  showsWindowBorder,
} from "../../src/lib/windowChrome";

describe("desktop window chrome platform decisions (design system section 4.13)", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "macos",
    ],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "windows"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36", "linux"],
    // An unrecognized user agent degrades to Linux rather than throwing;
    // Skribeum ships no fourth desktop target.
    ["Mozilla/5.0 (FreeBSD amd64)", "linux"],
  ] as const)("classifies %s as %s", (userAgent, expected) => {
    expect(platformFromUserAgent(userAgent)).toBe(expected);
  });

  it("draws caption buttons on Windows and Linux only", () => {
    expect(showsCaptionButtons("windows")).toBe(true);
    expect(showsCaptionButtons("linux")).toBe(true);
    expect(showsCaptionButtons("macos")).toBe(false);
  });

  it("fixes the caption button order to minimize, maximize, close", () => {
    expect(CAPTION_BUTTON_ORDER).toEqual(["minimize", "maximize", "close"]);
  });

  it("insets the macOS leading controls 5.5rem to clear the traffic lights", () => {
    expect(macosLeadingInsetRem(false, 0)).toBe(5.5);
  });

  it("drops the macOS inset back to the base value in native fullscreen", () => {
    expect(macosLeadingInsetRem(true, 0)).toBe(0);
    expect(macosLeadingInsetRem(true, 1.5)).toBe(1.5);
  });

  it("shows the window border only when neither maximized nor fullscreen", () => {
    expect(
      showsWindowBorder({ maximized: false, fullscreen: false, focused: true }),
    ).toBe(true);
    expect(
      showsWindowBorder({ maximized: true, fullscreen: false, focused: true }),
    ).toBe(false);
    expect(
      showsWindowBorder({ maximized: false, fullscreen: true, focused: true }),
    ).toBe(false);
  });

  it("rounds only the Linux window corner, only unmaximized and windowed", () => {
    const windowed = { maximized: false, fullscreen: false, focused: true };
    const maximized = { maximized: true, fullscreen: false, focused: true };
    const fullscreen = { maximized: false, fullscreen: true, focused: true };
    expect(linuxWindowRadiusRem("linux", windowed)).toBe(0.5);
    expect(linuxWindowRadiusRem("linux", maximized)).toBe(0);
    expect(linuxWindowRadiusRem("linux", fullscreen)).toBe(0);
    expect(linuxWindowRadiusRem("windows", windowed)).toBe(0);
    expect(linuxWindowRadiusRem("macos", windowed)).toBe(0);
  });

  it("dims the header foreground to 60% only while unfocused", () => {
    expect(headerForegroundOpacity(true)).toBe(1);
    expect(headerForegroundOpacity(false)).toBe(0.6);
  });

  it("scales the Maximize button's CSS-pixel rectangle to physical pixels for native hit-testing", () => {
    const domRect = { left: 1000, top: 8, width: 46, height: 40 };
    expect(maximizeButtonRectFromDomRect(domRect, 1)).toEqual({
      x: 1000,
      y: 8,
      width: 46,
      height: 40,
    });
    expect(maximizeButtonRectFromDomRect(domRect, 1.5)).toEqual({
      x: 1500,
      y: 12,
      width: 69,
      height: 60,
    });
    expect(maximizeButtonRectFromDomRect(domRect, 2)).toEqual({
      x: 2000,
      y: 16,
      width: 92,
      height: 80,
    });
  });
});
