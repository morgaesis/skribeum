// Design system section 4.13: the desktop window draws its own chrome. The
// caption-button code path is shared between Windows and Linux (geometry,
// hover fills, the danger fill on Close, the fixed button order, no system
// decorations), so this suite runs on both of the CI matrix's non-macOS
// legs and exercises that shared path plus the platform-neutral drag-region
// and window-state wiring; only the corner radius differs between them
// (Linux draws it, Windows rounds through the compositor). macOS draws no
// caption buttons at all and keeps native decorations for the traffic
// lights, so this suite skips there entirely: what it cannot exercise from
// any CI runner is the macOS native traffic lights and menu bar, and the
// Windows 11 snap layouts flyout on Maximize hover, both of which need a
// real session on that platform (see the pull request description).
//
// The second suite in this file, on the window never moving inside itself,
// runs on every platform including macOS, because the surface it protects is
// the one a reader sees when the application slides out from under the
// window's own controls.
import path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { SCRATCH_VAULT_PATH, VISUAL_NOTE_NAME } from "./scratchVault";

const isMacOS = process.platform === "darwin";
const isLinux = process.platform === "linux";
const modifierKey = isMacOS ? Key.Command : Key.Ctrl;

/** Invokes a raw Tauri command through the global bridge, following the
 * `executeAsync`-with-`done` convention this embedded WebDriver server
 * needs for promise-returning scripts (see `smoke.spec.ts`'s
 * `persistedFontSize`; a plain `execute(async () => ...)` never resolves
 * here). */
async function invokeTauriCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | string> {
  return browser.executeAsync(
    (name: string, payload: Record<string, unknown> | undefined, done) => {
      const tauri = (
        window as unknown as {
          __TAURI__?: {
            core: { invoke(name: string, args?: unknown): Promise<unknown> };
          };
        }
      ).__TAURI__;
      if (tauri === undefined) {
        done("no-global-tauri");
        return;
      }
      tauri.core
        .invoke(name, payload)
        .then((value) => done(value as T))
        .catch((error: unknown) => done(String(error)));
    },
    command,
    args,
  );
}

async function openVisualNote(): Promise<void> {
  await browser.executeAsync(
    (path: string, done: (opened: boolean) => void) => {
      const openNote = (
        window as Window & {
          __SKRIBEUM_E2E_OPEN_NOTE__?: (path: string) => Promise<void>;
        }
      ).__SKRIBEUM_E2E_OPEN_NOTE__;
      if (openNote === undefined) {
        done(false);
        return;
      }
      void openNote(path).then(() => done(true));
    },
    VISUAL_NOTE_NAME,
  );
}

/** Waits for the desktop header and tab strip to expose their two identities. */
async function waitForDesktopIdentity(): Promise<void> {
  const vaultControl = $('button[aria-label="Vaults"]');
  await vaultControl.waitForDisplayed({ timeout: 15000 });
  expect((await vaultControl.getText()).trim()).toBe(
    path.basename(SCRATCH_VAULT_PATH),
  );
  const selectedTab = $('.skr-tab[role="tab"][aria-selected="true"]');
  await selectedTab.waitForDisplayed({ timeout: 15000 });
  expect((await selectedTab.getText()).trim()).toBe("A room for reading");
}

/** Feeds a synthetic window-chrome state transition through the same state
 * path a real native window event would take (see `WindowControls.svelte`).
 * A real macOS or Windows session is required to confirm the transition
 * this simulates (focus loss, maximize) is reachable from genuine native
 * events; this only asserts the CSS consequence once state changes. */
async function setWindowChromeState(next: {
  maximized?: boolean;
  fullscreen?: boolean;
  focused?: boolean;
}): Promise<void> {
  await browser.execute((state) => {
    (
      window as Window & {
        __SKRIBEUM_E2E_SET_WINDOW_CHROME__?: (next: typeof state) => void;
      }
    ).__SKRIBEUM_E2E_SET_WINDOW_CHROME__?.(state);
  }, next);
}

/** Resolves a CSS color or custom-property value to its computed `rgb()`
 * form via a detached probe element, so token comparisons never depend on
 * string formatting. */
async function computedColor(value: string): Promise<string> {
  return browser.execute((color) => {
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, value);
}

async function rootFontSizePx(): Promise<number> {
  return browser.execute(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
}

// macOS draws no caption buttons and keeps native decorations, per the
// platform split above, so the suite is conditionally skipped there.
(isMacOS ? describe.skip : describe)(
  "desktop window chrome (design system section 4.13)",
  () => {
    before(async () => {
      await browser.tauri.switchWindow("main");
      await browser.setWindowSize(1100, 750);
      await openVisualNote();
      await waitForDesktopIdentity();
    });

    afterEach(async () => {
      // Every test that feeds a synthetic transition restores the rest state
      // so later tests in this file observe the window as genuinely unfocused
      // and unmaximized readers would.
      await setWindowChromeState({
        maximized: false,
        fullscreen: false,
        focused: true,
      });
    });

    it("reports no system decorations and puts the header at the top of the window", async () => {
      const decorated = await invokeTauriCommand<boolean>(
        "plugin:window|is_decorated",
        { label: "main" },
      );
      expect(decorated).toBe(false);

      // Unmaximized, the shell's own 1px border (design system section 4.13)
      // sits above the header, so the header's own top edge lands at the
      // border's width rather than the viewport's edge; a maximized window
      // drops that border and the header would sit flush with the top.
      const geometry = await browser.execute(() => {
        const shell = document.querySelector(".skr-shell") as Element;
        const header = document.querySelector(".skr-app-header");
        return {
          shellBorderTop: Number.parseFloat(
            getComputedStyle(shell).borderTopWidth,
          ),
          headerTop:
            header === null ? null : header.getBoundingClientRect().top,
        };
      });
      expect(geometry.headerTop).toBe(geometry.shellBorderTop);
    });

    it("draws the caption buttons in the fixed order with the specified geometry", async () => {
      const remPx = await rootFontSizePx();
      const geometry = await browser.execute(() => {
        const header = document.querySelector(".skr-app-header");
        const buttons = [
          ...document.querySelectorAll<HTMLElement>(".skr-caption-button"),
        ];
        return {
          headerHeight: header?.getBoundingClientRect().height ?? 0,
          testIds: buttons.map((button) => button.dataset.testid ?? ""),
          boxes: buttons.map((button) => {
            const box = button.getBoundingClientRect();
            return { width: box.width, height: box.height };
          }),
        };
      });

      expect(geometry.testIds).toEqual([
        "caption-minimize",
        "caption-maximize",
        "caption-close",
      ]);
      for (const box of geometry.boxes) {
        expect(box.width).toBeCloseTo(2.875 * remPx, 0);
        expect(box.height).toBeCloseTo(geometry.headerHeight, 0);
      }
    });

    it("declares the danger fill on the Close caption button's hover rule", async () => {
      // The embedded WebDriver provider synthesizes DOM events rather than
      // driving OS input (see the header comment in `smoke.spec.ts`), so the
      // browser's own `:hover` pseudo-class state is not reliably reachable
      // by moving the pointer here. This reads the authored CSS rule directly
      // instead of trying to trigger it, then resolves both sides of the
      // comparison through the same probe technique used elsewhere in the
      // suite so the assertion depends on computed color, not string form.
      const close = $('[data-testid="caption-close"]');
      await close.waitForDisplayed({ timeout: 10000 });
      const declaredBackground = await browser.execute(() => {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules)) {
            if (
              rule instanceof CSSStyleRule &&
              rule.selectorText.includes("skr-caption-button-close") &&
              rule.selectorText.includes(":hover")
            ) {
              return rule.style.backgroundColor;
            }
          }
        }
        return null;
      });
      expect(declaredBackground).not.toBeNull();
      const dangerToken = await browser.execute(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--skr-danger")
          .trim(),
      );
      expect(await computedColor(declaredBackground as string)).toBe(
        await computedColor(dangerToken),
      );
    });

    it("makes the non-interactive header area a drag region while excluding every control's hit area", async () => {
      const geometry = await browser.execute(() => {
        const header = document.querySelector<HTMLElement>(".skr-app-header");
        if (header === null) return null;
        const headerBox = header.getBoundingClientRect();
        // Only currently visible controls have a real hit area to exclude;
        // the narrow-layout Files button stays in the DOM at zero size on
        // this wide viewport and would otherwise read as escaping the header.
        const controls = [
          ...header.querySelectorAll<HTMLElement>("button"),
        ].filter(
          (control) =>
            getComputedStyle(control).display !== "none" &&
            control.getBoundingClientRect().width > 0,
        );
        const controlArea = controls.reduce((total, control) => {
          const box = control.getBoundingClientRect();
          return total + box.width * box.height;
        }, 0);
        const carriers = controls.filter((control) =>
          control.hasAttribute("data-tauri-drag-region"),
        );
        const escaping = controls.filter((control) => {
          const box = control.getBoundingClientRect();
          return (
            box.left < headerBox.left ||
            box.right > headerBox.right ||
            box.top < headerBox.top ||
            box.bottom > headerBox.bottom
          );
        });
        return {
          dragAttribute: header.getAttribute("data-tauri-drag-region"),
          headerArea: headerBox.width * headerBox.height,
          controlArea,
          controlCount: controls.length,
          carrierCount: carriers.length,
          escapingCount: escaping.length,
        };
      });
      if (geometry === null) throw new Error("header did not render");

      // The header itself carries the "deep" drag region: Tauri's injected
      // handler walks up from the click target and only treats a click as a
      // drag when no clickable ancestor without its own attribute sits in
      // between, which is exactly how every button below is excluded.
      expect(geometry.dragAttribute).toBe("deep");
      expect(geometry.controlCount).toBeGreaterThan(0);
      expect(geometry.carrierCount).toBe(0);
      expect(geometry.escapingCount).toBe(0);
      // The controls never cover the whole bar, so a genuine drag-eligible
      // area exists between and around them.
      expect(geometry.controlArea).toBeLessThan(geometry.headerArea);
    });

    it("dims the header foreground to 60% opacity while unfocused and leaves note content unaffected", async () => {
      const focused = await browser.execute(() => ({
        leading: getComputedStyle(
          document.querySelector(".skr-header-leading") as Element,
        ).opacity,
        trailing: getComputedStyle(
          document.querySelector(".skr-header-trailing") as Element,
        ).opacity,
        editor: getComputedStyle(document.querySelector(".editor") as Element)
          .opacity,
      }));
      expect(focused.leading).toBe("1");
      expect(focused.trailing).toBe("1");
      expect(focused.editor).toBe("1");

      await setWindowChromeState({ focused: false });
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () =>
              getComputedStyle(
                document.querySelector(".skr-header-leading") as Element,
              ).opacity,
          )) === "0.6",
        { timeout: 5000, timeoutMsg: "header foreground never dimmed" },
      );
      const unfocused = await browser.execute(() => ({
        leading: getComputedStyle(
          document.querySelector(".skr-header-leading") as Element,
        ).opacity,
        trailing: getComputedStyle(
          document.querySelector(".skr-header-trailing") as Element,
        ).opacity,
        editor: getComputedStyle(document.querySelector(".editor") as Element)
          .opacity,
      }));
      expect(unfocused.leading).toBe("0.6");
      expect(unfocused.trailing).toBe("0.6");
      expect(unfocused.editor).toBe("1");
    });

    it("shows the border and, on Linux, the corner radius only while unmaximized", async () => {
      const remPx = await rootFontSizePx();
      const windowed = await browser.execute(() => {
        const shell = document.querySelector(".skr-shell") as Element;
        const style = getComputedStyle(shell);
        return {
          borderWidth: style.borderTopWidth,
          radius: style.borderRadius,
        };
      });
      expect(windowed.borderWidth).toBe("1px");
      // Linux draws the 8px corner radius itself; Windows 11 rounds the
      // window through the compositor and keeps the product's own radius 0.
      if (isLinux) {
        expect(Number.parseFloat(windowed.radius)).toBeCloseTo(0.5 * remPx, 0);
      } else {
        expect(Number.parseFloat(windowed.radius) || 0).toBe(0);
      }

      await setWindowChromeState({ maximized: true });
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () =>
              getComputedStyle(document.querySelector(".skr-shell") as Element)
                .borderTopWidth,
          )) === "0px",
        { timeout: 5000, timeoutMsg: "window border never dropped" },
      );
      const maximized = await browser.execute(() => {
        const shell = document.querySelector(".skr-shell") as Element;
        const style = getComputedStyle(shell);
        return {
          borderWidth: style.borderTopWidth,
          radius: style.borderRadius,
        };
      });
      expect(maximized.borderWidth).toBe("0px");
      expect(Number.parseFloat(maximized.radius) || 0).toBe(0);
    });
  },
);

/** Every offset by which the whole application could be displaced inside its
 * own window, plus how much room there is to displace it by. The shell owns
 * its scroll regions explicitly, so all six read zero at all times. */
type ShellDisplacement = {
  documentTop: number;
  documentLeft: number;
  bodyTop: number;
  bodyLeft: number;
  documentOverflowDown: number;
  documentOverflowRight: number;
};

async function shellDisplacement(): Promise<ShellDisplacement> {
  return browser.execute(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      documentTop: root.scrollTop,
      documentLeft: root.scrollLeft,
      bodyTop: body.scrollTop,
      bodyLeft: body.scrollLeft,
      documentOverflowDown: root.scrollHeight - root.clientHeight,
      documentOverflowRight: root.scrollWidth - root.clientWidth,
    };
  });
}

const AT_REST: ShellDisplacement = {
  documentTop: 0,
  documentLeft: 0,
  bodyTop: 0,
  bodyLeft: 0,
  documentOverflowDown: 0,
  documentOverflowRight: 0,
};

/** Asks the page to scroll by every route a wheel, a trackpad swipe or a
 * stray script would take. Synthetic wheel events are untrusted and perform
 * no scrolling of their own, so the scrolling APIs stand in for them: they
 * command exactly the displacement a wheel would ask for, and reaching them
 * does not depend on this embedded WebDriver server driving OS input. */
async function tryToScrollTheWindow(): Promise<void> {
  await browser.execute(() => {
    const root = document.documentElement;
    const body = document.body;
    for (const offset of [400, 4000]) {
      window.scrollTo(offset, offset);
      window.scrollBy(offset, offset);
      root.scrollTop = offset;
      root.scrollLeft = offset;
      body.scrollTop = offset;
      body.scrollLeft = offset;
    }
  });
}

/**
 * Puts a surface far larger than the window into the page with a control
 * past the window's edge, focuses that control and asks for it to be
 * scrolled into view, then reports what the page did about it and takes the
 * surface away again. This is the pressure the resting shell cannot apply to
 * itself: a page that is free to grow grows here, and the whole application
 * follows the control off the bottom of the window. The shell is left as it
 * was found, focus included, so this can be applied to a shell mid-task.
 */
async function displacementUnderAnOversizedSurface(): Promise<
  ShellDisplacement & { focusedTheControl: boolean }
> {
  return browser.execute(() => {
    const focusedBefore = document.activeElement;
    const oversized = document.createElement("div");
    oversized.style.cssText =
      "position: absolute; top: 0; left: 0; width: 9000px; height: 9000px;";
    const control = document.createElement("button");
    control.style.cssText = "position: absolute; top: 8000px; left: 8000px;";
    control.textContent = "beyond the window";
    document.body.append(oversized, control);
    control.focus();
    control.scrollIntoView();
    const root = document.documentElement;
    const body = document.body;
    const measured = {
      documentTop: root.scrollTop,
      documentLeft: root.scrollLeft,
      bodyTop: body.scrollTop,
      bodyLeft: body.scrollLeft,
      documentOverflowDown: root.scrollHeight - root.clientHeight,
      documentOverflowRight: root.scrollWidth - root.clientWidth,
      // Reported so a zero offset reads as the page refusing to move rather
      // than as the probe never having asked it to.
      focusedTheControl: document.activeElement === control,
    };
    oversized.remove();
    control.remove();
    if (focusedBefore instanceof HTMLElement) focusedBefore.focus();
    root.scrollTop = 0;
    root.scrollLeft = 0;
    body.scrollTop = 0;
    body.scrollLeft = 0;
    return measured;
  });
}

const AT_REST_UNDER_PRESSURE = { ...AT_REST, focusedTheControl: true };

/** Sizes the window so its viewport lands close to the requested one and
 * reports what the viewport actually became, since window decorations and
 * platform minimums both take their cut. */
async function useViewport(
  width: number,
  height: number,
): Promise<{ width: number; height: number }> {
  let outerWidth = width;
  let outerHeight = height;
  let actual = { width: 0, height: 0 };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await browser.setWindowSize(outerWidth, outerHeight);
    actual = await browser.executeAsync<{ width: number; height: number }, []>(
      (done) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            done({ width: window.innerWidth, height: window.innerHeight }),
          ),
        );
      },
    );
    if (actual.width === width && actual.height === height) return actual;
    outerWidth += width - actual.width;
    outerHeight += height - actual.height;
  }
  return actual;
}

// The shell is a fixed frame around the scroll regions it owns, so the page
// underneath it has nothing to scroll and no room to scroll it in. When that
// stops holding, the whole application slides inside its window and leaves
// the window's own controls behind, which no control inside the application
// can undo. This suite runs on every platform, against the real desktop
// window rather than the browser demo, because the engine behind that window
// differs per platform and each one keeps its own page-scrolling behaviour.
describe("the application never moves inside its own window", () => {
  before(async () => {
    await browser.tauri.switchWindow("main");
    await useViewport(1100, 750);
    await openVisualNote();
    await waitForDesktopIdentity();
  });

  after(async () => {
    await useViewport(1100, 750);
  });

  it("has no page to scroll at any window size, and grows none under a surface larger than the window", async () => {
    // Wide enough for both side panels, narrow enough for the phone layout,
    // and smaller in each direction than the shell's own resting chrome
    // needs, so a layout that outgrows the window is exercised rather than
    // assumed away. The viewport travels with each expectation so a failure
    // names the size it happened at.
    for (const [width, height] of [
      [1100, 750],
      [900, 700],
      [640, 560],
      [420, 700],
      [360, 420],
    ]) {
      const viewport = await useViewport(width, height);
      expect({ viewport, ...(await shellDisplacement()) }).toEqual({
        viewport,
        ...AT_REST,
      });
      await tryToScrollTheWindow();
      expect({ viewport, ...(await shellDisplacement()) }).toEqual({
        viewport,
        ...AT_REST,
      });
      expect({
        viewport,
        ...(await displacementUnderAnOversizedSurface()),
      }).toEqual({ viewport, ...AT_REST_UNDER_PRESSURE });
    }
  });

  it("stays put while focus visits every control in the shell", async () => {
    await useViewport(1100, 750);
    // Focusing a control the browser considers out of view is the classic
    // way a page scrolls itself: the engine brings it into view by moving
    // whatever will move, and with a scrollable page that is the whole
    // application. Each control is reported by name so a regression names
    // the control that moved the window rather than only the offset.
    const displaced = await browser.execute(() => {
      const root = document.documentElement;
      const body = document.body;
      const focusable = [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const moved: { name: string; offsets: number[] }[] = [];
      for (const control of focusable) {
        control.focus();
        const offsets = [
          root.scrollTop,
          root.scrollLeft,
          body.scrollTop,
          body.scrollLeft,
        ];
        if (offsets.some((offset) => offset !== 0)) {
          moved.push({
            name:
              control.getAttribute("aria-label") ??
              control.getAttribute("data-command-id") ??
              control.textContent?.trim().slice(0, 40) ??
              control.tagName,
            offsets,
          });
          root.scrollTop = 0;
          root.scrollLeft = 0;
          body.scrollTop = 0;
          body.scrollLeft = 0;
        }
      }
      return { visited: focusable.length, moved };
    });
    expect(displaced.visited).toBeGreaterThan(4);
    expect(displaced.moved).toEqual([]);
    expect(await shellDisplacement()).toEqual(AT_REST);
  });

  it("stays put behind each overlay, under the same pressure", async () => {
    await useViewport(1100, 750);
    const overlays: [string, string, string][] = [
      ["command surface", "k", '[data-testid="unified-command-surface"]'],
      ["settings", ",", '[data-testid="settings-view"]'],
    ];
    for (const [name, key, selector] of overlays) {
      await browser.keys([modifierKey, key]);
      const surface = $(selector);
      await surface.waitForExist({
        timeout: 10000,
        timeoutMsg: `${name} never opened`,
      });
      await tryToScrollTheWindow();
      expect({ name, ...(await shellDisplacement()) }).toEqual({
        name,
        ...AT_REST,
      });
      expect({
        name,
        ...(await displacementUnderAnOversizedSurface()),
      }).toEqual({ name, ...AT_REST_UNDER_PRESSURE });
      await browser.keys(Key.Escape);
      await surface.waitForExist({ reverse: true, timeout: 10000 });
      expect({ name, ...(await shellDisplacement()) }).toEqual({
        name,
        ...AT_REST,
      });
    }
  });

  it("leaves the note's own scroll region scrolling and the visual viewport measuring the window", async () => {
    await useViewport(1100, 750);
    // The shell holding still must not be the whole application holding
    // still: the note scrolls inside its own region, and the keyboard-aware
    // viewport bounds still describe the window they are read against.
    const reading = await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      if (scroller === null) return null;
      scroller.scrollTop = 120;
      const scrolled = scroller.scrollTop;
      scroller.scrollTop = 0;
      const root = getComputedStyle(document.documentElement);
      return {
        scrolled,
        room: scroller.scrollHeight - scroller.clientHeight,
        viewportHeight: Number.parseFloat(
          root.getPropertyValue("--skr-visual-viewport-height"),
        ),
        viewportWidth: Number.parseFloat(
          root.getPropertyValue("--skr-visual-viewport-width"),
        ),
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
      };
    });
    if (reading === null) throw new Error("the note surface did not render");
    expect(reading.room).toBeGreaterThan(0);
    expect(reading.scrolled).toBe(Math.min(120, reading.room));
    expect(reading.scrolled).toBeGreaterThan(0);
    expect(reading.viewportHeight).toBeCloseTo(reading.innerHeight, 0);
    expect(reading.viewportWidth).toBeCloseTo(reading.innerWidth, 0);
    expect(await shellDisplacement()).toEqual(AT_REST);
  });
});
