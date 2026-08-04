// Section 4.15 properties panel and section 4.16 statusline: geometry and
// typed rendering asserted through computed style on the live desktop
// build, byte-exact frontmatter write-through asserted against the file on
// disk, first-paint capture of history restoration, and the statusline's
// segments, announcement routing, and viewport gating.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  PROPERTIES_NOTE_CONTENT,
  PROPERTIES_NOTE_NAME,
  SCRATCH_VAULT_PATH,
} from "./scratchVault";

const modifierKey = process.platform === "darwin" ? Key.Command : Key.Ctrl;

const EXPECTED_WORDS = PROPERTIES_NOTE_CONTENT.split(/\s+/).filter(
  (token) => token.length > 0,
).length;

function noteOnDisk(name: string): string {
  return readFileSync(path.join(SCRATCH_VAULT_PATH, name), "utf8");
}

async function waitForDisk(name: string, expected: string) {
  await browser.waitUntil(
    () => {
      try {
        return noteOnDisk(name) === expected;
      } catch {
        return false;
      }
    },
    {
      timeout: 10000,
      timeoutMsg: `expected ${name} on disk to become ${JSON.stringify(expected)}, got ${JSON.stringify(noteOnDisk(name))}`,
    },
  );
}

async function currentNotePath(): Promise<string | null> {
  return browser.execute(
    () =>
      (
        window as Window & {
          __SKRIBEUM_E2E_CURRENT_PATH__?: () => string | null;
        }
      ).__SKRIBEUM_E2E_CURRENT_PATH__?.() ?? null,
  );
}

async function openNote(name: string) {
  await browser.executeAsync(
    (notePath: string, done: (opened: boolean) => void) => {
      const open = (
        window as Window & {
          __SKRIBEUM_E2E_OPEN_NOTE__?: (path: string) => Promise<void>;
        }
      ).__SKRIBEUM_E2E_OPEN_NOTE__;
      if (open === undefined) {
        done(false);
        return;
      }
      void open(notePath).then(() => done(true));
    },
    name,
  );
  try {
    await browser.waitUntil(async () => (await currentNotePath()) === name, {
      timeout: 15000,
    });
  } catch {
    const snapshot = await browser.execute(() => {
      const seams = window as Window & {
        __SKRIBEUM_E2E_OPEN_NOTE__?: unknown;
        __SKRIBEUM_E2E_CURRENT_PATH__?: () => string | null;
      };
      return {
        openSeam: typeof seams.__SKRIBEUM_E2E_OPEN_NOTE__,
        current: seams.__SKRIBEUM_E2E_CURRENT_PATH__?.() ?? "seam-missing",
        treeRows: document.querySelectorAll('[role="treeitem"]').length,
        alert:
          document.querySelector('aside[role="alert"], .skr-error')
            ?.textContent ?? null,
      };
    });
    throw new Error(
      `${name} did not become the active note: ${JSON.stringify(snapshot)}`,
    );
  }
  await browser.waitUntil(
    () =>
      browser.execute(
        (expectedPath) =>
          document
            .querySelector(".skr-editor-pane-focused .skr-editor-shell")
            ?.getAttribute("data-note-path") === expectedPath,
        name,
      ),
    {
      timeout: 15000,
      timeoutMsg: `${name} did not finish rendering`,
    },
  );
}

async function viewportWidth(): Promise<number> {
  return browser.execute(() => window.innerWidth);
}

async function useDesktopViewport() {
  await browser.setWindowSize(1280, 800);
  await browser.waitUntil(async () => (await viewportWidth()) > 960, {
    timeout: 10000,
    timeoutMsg: "viewport did not return above the narrow breakpoint",
  });
}

async function usePhoneViewport() {
  await browser.setWindowSize(390, 844);
  await browser.waitUntil(async () => (await viewportWidth()) <= 960, {
    timeout: 10000,
    timeoutMsg: "viewport did not narrow below the breakpoint",
  });
}

async function clearWorkspaceStorage(): Promise<void> {
  await browser.execute(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("skribeum.workspace.v1."))
        localStorage.removeItem(key);
    }
  });
}

async function dismissBanners() {
  await browser.pause(250);
  for (const banner of await $$('aside[role="alert"]')) {
    const controls = await banner.$$("button");
    await controls.at(-1)?.click();
  }
}

describe("properties panel (section 4.15) and statusline (section 4.16)", () => {
  before(async () => {
    // This spec runs first in tests/e2e/wdio.conf.ts specifically so the
    // shared app window is still on its freshly launched desktop content:
    // later spec files navigate the same window to the browser demo URL and
    // never navigate it back, so a desktop-only spec placed after them would
    // find a demo page instead of the packaged app.
    await browser.tauri.switchWindow("main");
    await useDesktopViewport();
    await clearWorkspaceStorage();
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  after(async () => {
    writeFileSync(
      path.join(SCRATCH_VAULT_PATH, PROPERTIES_NOTE_NAME),
      PROPERTIES_NOTE_CONTENT,
    );
    await clearWorkspaceStorage();
    await useDesktopViewport();
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  it("renders the compact expanded panel with typed values on a wide viewport", async () => {
    await openNote(PROPERTIES_NOTE_NAME);
    const toggle = $(".skr-properties-toggle");
    await toggle.waitForDisplayed({ timeout: 15000 });
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await toggle.getText()).toContain("5");

    const geometry = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>(".skr-properties");
      const header = document.querySelector<HTMLElement>(
        ".skr-properties-toggle",
      );
      const label = document.querySelector<HTMLElement>(".skr-property-label");
      const row = document.querySelector<HTMLElement>(".skr-property-row");
      const value = document.querySelector<HTMLElement>(
        '.skr-property-editable[data-property-key="title"]',
      );
      if (!panel || !header || !label || !row || !value) return null;
      const valueStyle = getComputedStyle(value);
      return {
        panelBackground: getComputedStyle(panel).backgroundColor,
        headerHeight: header.getBoundingClientRect().height,
        labelWidth: getComputedStyle(label).width,
        rowHeight: row.getBoundingClientRect().height,
        valueBorderBottomWidth: valueStyle.borderBottomWidth,
        valueRestBorderColor: valueStyle.borderBottomColor,
        valueBackground: valueStyle.backgroundColor,
      };
    });
    expect(geometry).not.toBeNull();
    if (geometry === null) return;
    // The compact form of section 4.15: a 1.75rem header row, 1.75rem
    // one-line rows, and an 8rem label column, asserted as computed pixels.
    expect(geometry.headerHeight).toBeCloseTo(28, 0);
    expect(geometry.labelWidth).toBe("128px");
    expect(geometry.rowHeight).toBeCloseTo(28, 0);
    // Flat values on a flat panel: no fill, no box, and the edit-state
    // bottom rule stays reserved but transparent at rest.
    expect(geometry.panelBackground).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.valueBackground).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.valueBorderBottomWidth).toBe("1px");
    expect(geometry.valueRestBorderColor).toContain("rgba(0, 0, 0, 0)");
    expect(await $$(".skr-properties input[type='text']")).toHaveLength(0);

    // Typed rendering: a 3.6 checkbox, list chips, the ISO date as text,
    // and the wikilink value as a link.
    const checkbox = $(".skr-property-checkbox input[type='checkbox']");
    expect(await checkbox.isExisting()).toBe(true);
    expect(await checkbox.isSelected()).toBe(false);
    const chips = await $$(".skr-property-chip");
    expect(chips).toHaveLength(2);
    expect(await chips[0]?.getText()).toBe("alpha");
    const chipStyle = await browser.execute(() => {
      const chip = document.querySelector<HTMLElement>(".skr-property-chip");
      if (!chip) return null;
      const style = getComputedStyle(chip);
      return { radius: style.borderRadius, background: style.backgroundColor };
    });
    expect(chipStyle?.radius).toBe("4px");
    expect(chipStyle?.background).not.toBe("rgba(0, 0, 0, 0)");
    const dateValue = $('.skr-property-editable[data-property-key="reviewed"]');
    expect(await dateValue.getText()).toBe("2026-01-10");
    const wikilink = $(
      '.skr-property-wikilink[data-wikilink-target="zzz-navigation-target"]',
    );
    expect(await wikilink.isExisting()).toBe(true);
    expect(await wikilink.getText()).toBe("zzz-navigation-target");
  });

  it("writes edits through to the exact frontmatter bytes", async () => {
    await openNote(PROPERTIES_NOTE_NAME);
    const title = $('.skr-property-editable[data-property-key="title"]');
    await title.waitForDisplayed({ timeout: 15000 });
    await title.click();
    // The caret sits in the value: document.activeElement is the portable
    // signal a click entered edit mode, confirmed on every platform this
    // suite runs on. The visible 1px edit-state bottom rule of section
    // 5.12 is real :focus-driven CSS, but some headless macOS automation
    // never makes the browser window the OS key window, and WebKit does
    // not paint :focus styling for a document that reports itself
    // unfocused even though activeElement is set correctly; the border
    // check below is scoped to document.hasFocus() so it still holds
    // platforms accountable for the visual rule without failing on an
    // environment that cannot observe it.
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.activeElement ===
            document.querySelector(
              '.skr-property-editable[data-property-key="title"]',
            ),
        ),
      { timeout: 5000, timeoutMsg: "the title value never became focused" },
    );
    const borderState = await browser.execute(() => {
      const value = document.querySelector<HTMLElement>(
        '.skr-property-editable[data-property-key="title"]',
      );
      return {
        documentFocused: document.hasFocus(),
        border: value ? getComputedStyle(value).borderBottomColor : null,
      };
    });
    if (borderState.documentFocused) {
      expect(borderState.border).not.toContain("rgba(0, 0, 0, 0)");
    }

    await browser.keys([modifierKey, "a"]);
    // Typed text reaches a contenteditable region through the element's own
    // send-keys endpoint, not the session-level key stream (see the note at
    // the top of tests/e2e/smoke.spec.ts on how CodeMirror content receives
    // typed text); the selected text from Mod-A is replaced the same way a
    // real keystroke replaces an active selection.
    await title.addValue("Retitled fixture");
    await browser.waitUntil(
      () =>
        browser
          .execute(
            () =>
              document.querySelector<HTMLElement>(
                '.skr-property-editable[data-property-key="title"]',
              )?.textContent ?? "",
          )
          .then((text) => text === "Retitled fixture"),
      {
        timeout: 5000,
        timeoutMsg: "typed text did not land in the focused value",
      },
    );
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      () =>
        browser
          .execute(
            () =>
              document.querySelector<HTMLElement>(
                '.skr-property-editable[data-property-key="title"]',
              )?.textContent ?? "",
          )
          .then((text) => text === "Retitled fixture"),
      {
        timeout: 5000,
        timeoutMsg: "the committed value did not re-render from the document",
      },
    );

    const checkbox = $(".skr-property-checkbox input[type='checkbox']");
    await checkbox.click();
    await browser.waitUntil(async () => checkbox.isSelected(), {
      timeout: 5000,
      timeoutMsg: "the checkbox did not commit true",
    });

    await browser.keys([modifierKey, "s"]);
    const expected = PROPERTIES_NOTE_CONTENT.replace(
      "title: Properties fixture",
      "title: Retitled fixture",
    ).replace("published: false", "published: true");
    await waitForDisk(PROPERTIES_NOTE_NAME, expected);

    // Restore the fixture for the remaining cases.
    writeFileSync(
      path.join(SCRATCH_VAULT_PATH, PROPERTIES_NOTE_NAME),
      PROPERTIES_NOTE_CONTENT,
    );
    await waitForDisk(PROPERTIES_NOTE_NAME, PROPERTIES_NOTE_CONTENT);
    await dismissBanners();
  });

  it("shows the statusline segments and the note-info popover on desktop", async () => {
    await openNote(PROPERTIES_NOTE_NAME);
    const statusline = $('[data-testid="statusline"]');
    await statusline.waitForDisplayed({ timeout: 15000 });

    const barStyle = await browser.execute(() => {
      const bar = document.querySelector<HTMLElement>(
        '[data-testid="statusline"]',
      );
      if (!bar) return null;
      const style = getComputedStyle(bar);
      return {
        height: bar.getBoundingClientRect().height,
        borderTopWidth: style.borderTopWidth,
        fontSize: style.fontSize,
      };
    });
    expect(barStyle?.height).toBeCloseTo(24, 0);
    expect(barStyle?.borderTopWidth).toBe("1px");
    expect(barStyle?.fontSize).toBe("12px");

    const edited = $('[data-testid="statusline-edited"]');
    await edited.waitForDisplayed({ timeout: 15000 });
    expect(await edited.getText()).toMatch(/^Edited /);

    const wordCount = $('[data-testid="statusline-word-count"]');
    await browser.waitUntil(
      async () => (await wordCount.getText()) === `${EXPECTED_WORDS} words`,
      {
        timeout: 15000,
        timeoutMsg: `word count did not settle at ${EXPECTED_WORDS} words`,
      },
    );

    // The persistence slot is silent while everything is saved.
    expect(await $('[data-testid="statusline-persistence"]').isExisting()).toBe(
      false,
    );
    // Line and column stay out of the bar during ordinary writing.
    expect(await $('[data-testid="statusline-line-column"]').isExisting()).toBe(
      false,
    );

    await edited.click();
    const popover = $('[data-testid="note-info-popover"]');
    await popover.waitForDisplayed({ timeout: 10000 });
    const facts = await popover.getText();
    expect(facts).toContain("Created");
    expect(facts).toContain("Modified");
    expect(facts).toContain(PROPERTIES_NOTE_NAME);
    expect(facts).toContain(String(EXPECTED_WORDS));
    await browser.keys(Key.Escape);
    await popover.waitForExist({ reverse: true, timeout: 10000 });
  });

  it("tracks a selection in the word count and joins Ln and Col in source mode", async () => {
    await openNote(PROPERTIES_NOTE_NAME);
    const selectedSentence = "Property fixture body one two three.";
    // Sets the selection through the same e2e seam used elsewhere in this
    // file rather than a keyboard chord: named keys like End are not part
    // of the confirmed-reliable set for this WebKitGTK build (only arrows
    // and Enter are, per the note at the top of tests/e2e/smoke.spec.ts),
    // and this test is about the statusline reflecting a selection, not
    // about CodeMirror's own key handling.
    await browser.execute((sentence: string) => {
      (
        window as Window & {
          __SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?: (
            sourceText: string,
            relativeOffset: number,
            relativeSelectionLength?: number,
          ) => number | null;
        }
      ).__SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?.(sentence, 0, sentence.length);
    }, selectedSentence);
    const wordCount = $('[data-testid="statusline-word-count"]');
    await browser.waitUntil(
      async () =>
        (await wordCount.getText()) === `6 of ${EXPECTED_WORDS} words`,
      {
        timeout: 10000,
        timeoutMsg: "selection word count did not appear",
      },
    );
    await browser.execute((sentence: string) => {
      (
        window as Window & {
          __SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?: (
            sourceText: string,
            relativeOffset: number,
          ) => number | null;
        }
      ).__SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?.(sentence, sentence.length);
    }, selectedSentence);
    await browser.waitUntil(
      async () => (await wordCount.getText()) === `${EXPECTED_WORDS} words`,
      {
        timeout: 10000,
        timeoutMsg: "word count did not return to the document total",
      },
    );

    await $('button[aria-label="More actions"]').click();
    const overflow = $('[data-testid="overlay-sheet"]');
    await overflow.waitForDisplayed({ timeout: 10000 });
    await overflow.$('[data-command-id="editor.toggle-source-mode"]').click();
    await overflow.waitForExist({ reverse: true, timeout: 10000 });
    const lineColumn = $('[data-testid="statusline-line-column"]');
    await lineColumn.waitForDisplayed({ timeout: 10000 });
    expect(await lineColumn.getText()).toMatch(/^Ln \d+, Col \d+$/);
    // Exits through the registered keybinding rather than a second overflow
    // round trip: Mod-E is the same toggle command's shortcut (confirmed
    // reliable for modifier-plus-letter chords in this WebKitGTK build).
    await browser.keys([modifierKey, "e"]);
    await lineColumn.waitForExist({ reverse: true, timeout: 10000 });
  });

  it("announces a copied link in the center slot and fades it out", async () => {
    await openNote(PROPERTIES_NOTE_NAME);
    // The clipboard is stubbed so the announcement path under test is
    // deterministic in a headless webview.
    await browser.execute(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.resolve() },
        configurable: true,
      });
    });
    await $('button[aria-label="More actions"]').click();
    const overflow = $('[data-testid="overlay-sheet"]');
    await overflow.waitForDisplayed({ timeout: 10000 });
    await overflow.$('[data-command-id="link.copy-note"]').click();

    const slot = $('[data-testid="statusline-announcements"]');
    expect(await slot.getAttribute("aria-live")).toBe("polite");
    const announcement = slot.$(".skr-statusline-announcement");
    await announcement.waitForDisplayed({ timeout: 5000 });
    expect(await announcement.getText()).toBe("Link copied");
    // On wide viewports the confirmation lives in the statusline, not the
    // banner strip.
    expect(await $('aside[role="status"]').isExisting()).toBe(false);
    // The dismissal is the 50ms state-class opacity fade of section 5.1;
    // some CI runners default to prefers-reduced-motion, which zeros every
    // duration per section 5.1 (see resolves_state_surface_and_panel_motion
    // _from_the_built_theme in tests/e2e/smoke.spec.ts for the same check).
    const transition = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>(
        ".skr-statusline-announcement",
      );
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        duration: style.transitionDuration,
        property: style.transitionProperty,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      };
    });
    expect(transition?.duration).toBe(
      transition?.reducedMotion ? "0s" : "0.05s",
    );
    expect(transition?.property).toContain("opacity");
    await announcement.waitForExist({ reverse: true, timeout: 5000 });
  });

  it("collapses the panel by default and drops the statusline at phone width", async () => {
    // A fresh open applies the form-factor default only without a
    // persisted tab view-state to restore, so start from a clean workspace.
    await clearWorkspaceStorage();
    await usePhoneViewport();
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
    await openNote(PROPERTIES_NOTE_NAME);
    const toggle = $(".skr-properties-toggle");
    await toggle.waitForDisplayed({ timeout: 15000 });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      await browser.execute(
        () =>
          document.querySelector<HTMLElement>(".skr-properties-content")
            ?.offsetHeight ?? null,
      ),
    ).toBe(0);
    expect(await $('[data-testid="statusline"]').isExisting()).toBe(false);

    await clearWorkspaceStorage();
    await useDesktopViewport();
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  it("restores a recorded collapsed panel with no intermediate expanded frame", async () => {
    await openNote(PROPERTIES_NOTE_NAME);
    const toggle = $(".skr-properties-toggle");
    await toggle.waitForDisplayed({ timeout: 15000 });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    // Record a collapsed panel state, then leave through the history.
    await toggle.click();
    await browser.waitUntil(
      async () => (await toggle.getAttribute("aria-expanded")) === "false",
      { timeout: 5000, timeoutMsg: "panel did not collapse" },
    );
    await openNote("zzz-navigation-target.md");

    // First-paint capture: every animation frame from before Back until
    // well past arrival records the panel's expansion state and content
    // height. A frame that shows the panel expanded before settling
    // collapsed is the section 6.4 flicker defect.
    await browser.execute(() => {
      const recorder = window as Window & {
        __PANEL_FRAMES__?: Array<{ expanded: string | null; height: number }>;
        __PANEL_RECORDING__?: boolean;
      };
      recorder.__PANEL_FRAMES__ = [];
      recorder.__PANEL_RECORDING__ = true;
      const record = () => {
        if (recorder.__PANEL_RECORDING__ !== true) return;
        const panelToggle = document.querySelector<HTMLElement>(
          ".skr-properties-toggle",
        );
        const content = document.querySelector<HTMLElement>(
          ".skr-properties-content",
        );
        if (panelToggle !== null) {
          recorder.__PANEL_FRAMES__?.push({
            expanded: panelToggle.getAttribute("aria-expanded"),
            height: content?.offsetHeight ?? 0,
          });
        }
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });

    await $('[data-command-id="navigation.back"]').click();
    await browser.waitUntil(
      async () => (await currentNotePath()) === PROPERTIES_NOTE_NAME,
      { timeout: 15000, timeoutMsg: "Back did not return to the note" },
    );
    // Cover the full 160ms panel-motion window plus settling.
    await browser.pause(500);
    const frames = await browser.execute(() => {
      const recorder = window as Window & {
        __PANEL_FRAMES__?: Array<{ expanded: string | null; height: number }>;
        __PANEL_RECORDING__?: boolean;
      };
      recorder.__PANEL_RECORDING__ = false;
      return recorder.__PANEL_FRAMES__ ?? [];
    });
    expect(frames.length).toBeGreaterThan(0);
    const expandedFrames = frames.filter(
      (frame) => frame.expanded === "true" || frame.height > 0,
    );
    expect(expandedFrames).toHaveLength(0);
    // The last recorded frame already confirms the settled state; querying
    // fresh here (rather than reusing the toggle reference captured before
    // the panel remounted on arrival) avoids a stale-element race against
    // that remount.
    expect(frames.at(-1)?.expanded).toBe("false");
    expect(
      await browser.execute(
        () =>
          document
            .querySelector(".skr-properties-toggle")
            ?.getAttribute("aria-expanded") ?? null,
      ),
    ).toBe("false");

    // A fresh open (no tab view-state to restore) returns to the
    // wide-viewport default: close the tab, then open the note again.
    await browser.keys([modifierKey, "w"]);
    await browser.waitUntil(
      async () => (await currentNotePath()) !== PROPERTIES_NOTE_NAME,
      { timeout: 10000, timeoutMsg: "the properties tab did not close" },
    );
    await openNote(PROPERTIES_NOTE_NAME);
    await browser.waitUntil(
      async () =>
        (await $(".skr-properties-toggle").getAttribute("aria-expanded")) ===
        "true",
      {
        timeout: 10000,
        timeoutMsg: "fresh open did not apply the expanded default",
      },
    );
  });

  it("adds a property through the ghost row", async () => {
    await openNote(PROPERTIES_NOTE_NAME);
    const panelToggle = $(".skr-properties-toggle");
    await panelToggle.waitForDisplayed({ timeout: 15000 });
    if ((await panelToggle.getAttribute("aria-expanded")) !== "true") {
      await panelToggle.click();
      await browser.waitUntil(
        async () =>
          (await panelToggle.getAttribute("aria-expanded")) === "true",
        { timeout: 5000, timeoutMsg: "panel did not expand" },
      );
    }
    const addButton = $(".skr-properties-add");
    await addButton.waitForExist({ timeout: 15000 });
    // The ghost row reveals on panel hover (hover is an enhancement; the
    // registered command reaches the same flow without it). Dispatching the
    // pointer event directly matches how hover reveals are driven and
    // verified elsewhere (App.svelte's sidebar header actions, the link
    // preview in tests/e2e/workspace.spec.ts): a real WebDriver pointer
    // move does not reliably land the browser's native :hover state in
    // this WebKitGTK build.
    await browser.execute(() => {
      document
        .querySelector(".skr-properties")
        ?.dispatchEvent(
          new PointerEvent("pointerenter", { bubbles: false, pointerId: 31 }),
        );
    });
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const ghost = document.querySelector<HTMLElement>(
            ".skr-properties-add",
          );
          return ghost !== null && getComputedStyle(ghost).opacity === "1";
        }),
      { timeout: 5000, timeoutMsg: "ghost row did not reveal on hover" },
    );
    await addButton.click();
    const keyCell = $(".skr-property-add-key");
    await keyCell.waitForDisplayed({ timeout: 10000 });
    // Typed text reaches a contenteditable region through the element's
    // own send-keys endpoint, not the session-level key stream (see the
    // note at the top of tests/e2e/smoke.spec.ts).
    await keyCell.addValue("stage");
    await browser.keys(Key.Enter);
    const valueCell = $(
      ".skr-property-add-row .skr-property-value .skr-property-editable",
    );
    await valueCell.waitForDisplayed({ timeout: 5000 });
    await valueCell.addValue("review");
    await browser.keys(Key.Enter);
    await browser.keys([modifierKey, "s"]);
    const expected = PROPERTIES_NOTE_CONTENT.replace(
      'source: "[[zzz-navigation-target]]"\n---',
      'source: "[[zzz-navigation-target]]"\nstage: review\n---',
    );
    await waitForDisk(PROPERTIES_NOTE_NAME, expected);
    writeFileSync(
      path.join(SCRATCH_VAULT_PATH, PROPERTIES_NOTE_NAME),
      PROPERTIES_NOTE_CONTENT,
    );
    await waitForDisk(PROPERTIES_NOTE_NAME, PROPERTIES_NOTE_CONTENT);
    await dismissBanners();
  });
});
