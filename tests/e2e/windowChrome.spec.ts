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
import { $, browser, expect } from "@wdio/globals";
import { VISUAL_NOTE_NAME } from "./scratchVault";

const isMacOS = process.platform === "darwin";
const isLinux = process.platform === "linux";

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
      await $("[data-testid=note-title]").waitForExist({ timeout: 15000 });
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
