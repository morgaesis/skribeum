import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser, expect } from "@wdio/globals";
import axe from "axe-core";
import { Key } from "webdriverio";
import {
  CANVAS_FILE_CONTENT,
  CANVAS_FILE_NAME,
  CRLF_NOTE_NAME,
  LF_NOTE_NAME,
  LIVE_PREVIEW_NOTE_CONTENT,
  LIVE_PREVIEW_NOTE_NAME,
  MOTION_PREVIEW_NOTE_NAME,
  NAVIGATION_SOURCE_NOTE_NAME,
  RENDERING_NOTE_NAME,
  REVEAL_NOTE_CONTENT,
  REVEAL_NOTE_NAME,
  SCRATCH_VAULT_PATH,
  VISUAL_NOTE_CONTENT,
  VISUAL_NOTE_NAME,
} from "./scratchVault";

// The embedded WebDriver provider synthesizes DOM events in the page
// rather than driving OS input. Consequences the tests are written
// around: text enters contenteditable surfaces through the element
// send-keys endpoint (`addValue`, which runs the browser's own
// `insertText` editing command through CodeMirror's real input pipeline);
// chords and named keys (arrows, Enter) reach JavaScript key handlers;
// and focus movement for Tab must be asserted at the handler level
// (nothing captures the key) plus driven programmatically, because a
// synthesized keydown never triggers the browser's default focus
// traversal.

const specDirectory = path.dirname(fileURLToPath(import.meta.url));
const screenshotDirectory = path.join(specDirectory, "screenshots");

const modifierKey = process.platform === "darwin" ? Key.Command : Key.Ctrl;

before(async () => {
  // Pin the sole application window after the Tauri service initializes. The
  // service then skips its automatic nested focus probe before DOM commands.
  await browser.tauri.switchWindow("main");
});

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

async function openNoteFromTree(name: string) {
  const row = $(`li=${name}`);
  await row.waitForExist({ timeout: 15000 });
  await row.click();
}

type ViewportSize = { width: number; height: number };

async function viewportAfterPaint(): Promise<ViewportSize> {
  return browser.executeAsync<ViewportSize, []>((done) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        done({ width: window.innerWidth, height: window.innerHeight });
      });
    });
  });
}

async function setViewportSize(
  width: number,
  height: number,
): Promise<ViewportSize> {
  let outerWidth = width;
  let outerHeight = height;
  let actual = { width: 0, height: 0 };
  let previous = actual;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await browser.setWindowSize(outerWidth, outerHeight);
    actual = await viewportAfterPaint();
    if (actual.width === width && actual.height === height) return actual;
    if (
      attempt > 0 &&
      actual.width === previous.width &&
      actual.height === previous.height
    ) {
      break;
    }

    previous = actual;
    outerWidth += width - actual.width;
    outerHeight += height - actual.height;
  }

  // Hosted macOS displays cap native window height below 844 pixels. The
  // exact requested viewport is exercised when the display permits it; a
  // capped host still exercises the same width at the smaller phone height.
  if (actual.width === width && actual.height >= 640) return actual;

  throw new Error(
    `viewport did not become ${width}x${height}; got ${actual.width}x${actual.height}`,
  );
}

async function restoreDesktopViewport() {
  await browser.setWindowSize(1100, 750);
  await browser.waitUntil(
    async () => (await viewportAfterPaint()).width > 960,
    {
      timeout: 10000,
      timeoutMsg: "viewport did not return above the narrow breakpoint",
    },
  );
}

type HorizontalEscape = {
  element: string;
  left: number;
  right: number;
  viewportWidth: number;
};

async function horizontalViewportEscapes(): Promise<HorizontalEscape[]> {
  return browser.execute(() => {
    const viewportWidth = window.innerWidth;
    const tolerance = 0.5;
    return [...document.querySelectorAll<HTMLElement>("*")].flatMap(
      (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          box.width === 0 ||
          box.height === 0 ||
          (box.left >= -tolerance && box.right <= viewportWidth + tolerance)
        ) {
          return [];
        }
        const identity = [
          element.tagName.toLowerCase(),
          element.id === "" ? "" : `#${element.id}`,
          ...[...element.classList].map((name) => `.${name}`),
        ].join("");
        return [
          {
            element: identity,
            left: box.left,
            right: box.right,
            viewportWidth,
          },
        ];
      },
    );
  });
}

async function editorText(): Promise<string> {
  return $(".cm-content").getText();
}

/** Places the browser selection at the end of the editor line with `text`. */
async function placeCursorAtLineEnd(text: string) {
  await browser.execute((lineText: string) => {
    const line = [...document.querySelectorAll(".cm-line")].find(
      (candidate) => {
        const visibleContent = candidate.cloneNode(true) as HTMLElement;
        for (const marker of visibleContent.querySelectorAll(
          ".cm-skr-reveal-marker",
        )) {
          marker.remove();
        }
        const content = visibleContent.textContent ?? "";
        return content === lineText || content.endsWith(lineText);
      },
    );
    if (line === undefined) {
      throw new Error(`no editor line with text ${lineText}`);
    }
    (line as HTMLElement).click();
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, text);
  // Let CodeMirror's DOM observer sync the selection change.
  await browser.pause(200);
}

type RevealClickPoint = "top" | "title" | "body" | "bottom";

async function clickRevealPoint(point: RevealClickPoint) {
  const coordinates = await browser.execute(
    (requestedPoint: RevealClickPoint) => {
      const calloutLines = [
        ...document.querySelectorAll<HTMLElement>(
          ".cm-line.cm-skr-rich-callout",
        ),
      ];
      let x: number;
      let y: number;
      const first = calloutLines[0];
      const last = calloutLines.at(-1);
      if (first === undefined || last === undefined) {
        throw new Error("rendered callout lines missing");
      }
      if (requestedPoint === "top") {
        const rect = first.getBoundingClientRect();
        const editorRect = first
          .closest<HTMLElement>(".cm-editor")
          ?.getBoundingClientRect();
        x = Math.max(rect.left + 8, (editorRect?.left ?? rect.left) + 8);
        y = rect.top + 2;
      } else if (requestedPoint === "bottom") {
        const rect = last.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.bottom - 2;
      } else {
        const text =
          requestedPoint === "title" ? "Linked callout" : "First body line";
        const line = [
          ...document.querySelectorAll<HTMLElement>(".cm-line"),
        ].find((candidate) => candidate.textContent?.includes(text));
        if (line === undefined) {
          throw new Error(`callout line missing: ${text}`);
        }
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let rect: DOMRect | null = null;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const value = node.textContent ?? "";
          const index = value.indexOf(text);
          if (index >= 0) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + text.length);
            rect = range.getBoundingClientRect();
            break;
          }
        }
        if (rect === null) {
          throw new Error(`callout text missing: ${text}`);
        }
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }

      if (document.elementFromPoint(x, y) === null) {
        throw new Error(`no click target for ${requestedPoint}`);
      }
      return { x: Math.round(x), y: Math.round(y) };
    },
    point,
  );
  await browser.performActions([
    {
      type: "pointer",
      id: "callout-reveal-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        {
          type: "pointerMove",
          duration: 0,
          origin: "viewport",
          x: coordinates.x,
          y: coordinates.y,
        },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
  await browser.pause(200);
}

async function editorCursor() {
  return browser.execute(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const line =
      anchor instanceof Element
        ? anchor.closest<HTMLElement>(".cm-line")
        : anchor?.parentElement?.closest<HTMLElement>(".cm-line");
    if (
      selection === null ||
      anchor === undefined ||
      anchor === null ||
      line === null
    ) {
      return { line: "", offset: -1 };
    }
    const range = document.createRange();
    range.selectNodeContents(line);
    const maximumOffset =
      anchor.nodeType === Node.TEXT_NODE
        ? (anchor.textContent?.length ?? 0)
        : anchor.childNodes.length;
    range.setEnd(anchor, Math.min(selection.anchorOffset, maximumOffset));
    return { line: line.textContent ?? "", offset: range.toString().length };
  });
}

async function calloutVisualIdentity() {
  return browser.execute(() => {
    const line = document.querySelector<HTMLElement>(
      ".cm-line.cm-skr-rich-callout",
    );
    if (line === null) {
      return null;
    }
    return {
      accent: line.dataset.accent ?? "",
      borderLeftColor: getComputedStyle(line).borderLeftColor,
      revealed: line.dataset.revealed === "true",
    };
  });
}

/** Activates one of the direct theme radio buttons. */
async function selectTheme(value: string) {
  const button = $(`[data-testid="settings-theme-${value}"]`);
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await browser.waitUntil(
    async () => (await button.getAttribute("aria-checked")) === "true",
    { timeout: 10000, timeoutMsg: `${value} theme did not become active` },
  );
}

async function applyVisualTheme(value: "light" | "dark") {
  await browser.execute((theme: string) => {
    document.documentElement.dataset.theme = theme;
  }, value);
  await browser.execute(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function selectEditorText(text: string) {
  await browser.execute((needle: string) => {
    const root = document.querySelector(".cm-content");
    if (root === null) {
      throw new Error("editor content missing");
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      const start = node.textContent?.indexOf(needle) ?? -1;
      if (start < 0) {
        continue;
      }
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      root.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      return;
    }
    throw new Error(`text not found: ${needle}`);
  }, text);
  await browser.pause(250);
}

async function placeCursorInsideEditorText(text: string) {
  await browser.execute((needle: string) => {
    const root = document.querySelector(".cm-content");
    if (root === null) {
      throw new Error("editor content missing");
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      const start = node.textContent?.indexOf(needle) ?? -1;
      if (start < 0) {
        continue;
      }
      const range = document.createRange();
      range.setStart(node, start + Math.floor(needle.length / 2));
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      root.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      return;
    }
    throw new Error(`text not found: ${needle}`);
  }, text);
  await browser.pause(250);
}

async function clearEditorSelection() {
  await browser.execute(() => {
    const root = document.querySelector(".cm-content");
    const line = root?.querySelector(".cm-line");
    const selection = window.getSelection();
    if (line !== null && line !== undefined && selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(line);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    root?.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  });
  await browser.waitUntil(
    async () => !(await $(".cm-skr-selection-toolbar").isExisting()),
    { timeout: 5000 },
  );
}

async function activeElementDescriptor(): Promise<string> {
  return browser.execute(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return "body";
    }
    const role = active.getAttribute("role");
    return `${active.tagName.toLowerCase()}:${role ?? ""}:${active.className}:${active.textContent?.slice(0, 40) ?? ""}`;
  });
}

async function expectNoAxeViolations(surface: string) {
  await browser.execute(axe.source);
  const violations = await browser.executeAsync<
    Array<{ id: string; impact: string | null; targets: string[] }>,
    []
  >((done) => {
    const runner = (
      window as unknown as {
        axe?: {
          run: () => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[] }>;
            }>;
          }>;
        };
      }
    ).axe;
    if (runner === undefined) {
      done([{ id: "axe-unavailable", impact: "critical", targets: [] }]);
      return;
    }
    runner
      .run()
      .then((result) =>
        done(
          result.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            targets: violation.nodes.flatMap((node) => node.target),
          })),
        ),
      )
      .catch((error: unknown) =>
        done([{ id: String(error), impact: "critical", targets: [] }]),
      );
  });
  if (violations.length > 0) {
    throw new Error(`${surface}: ${JSON.stringify(violations)}`);
  }
  expect(violations).toEqual([]);
}

describe("skribeum shell", () => {
  it("launches_and_renders_fixture", async () => {
    expect(await browser.getTitle()).toBe("Skribeum");

    const editorContent = $(".cm-content");
    await editorContent.waitForExist({ timeout: 15000 });

    // The fixture renders decorated: emphasis asterisks are hidden and
    // the task marker is a checkbox widget, so the assertions cover the
    // rendered text, not the raw source. The heading marker is exempt
    // here: the initial cursor sits at offset zero, on the heading line,
    // where cursor-line reveal legitimately shows it; the dedicated
    // live-preview spec covers marker hiding.
    const renderedText = await editorContent.getText();
    expect(renderedText).toContain("Skribeum");
    expect(renderedText).toContain(
      "Byte-faithful editing of plain Markdown, rendered by CodeMirror 6.",
    );
    expect(renderedText).toContain(
      "scaffold fixture, replaced when vaults open",
    );
    expect(renderedText).not.toContain("*plain*");

    mkdirSync(screenshotDirectory, { recursive: true });
    await browser.saveScreenshot(path.join(screenshotDirectory, "smoke.png"));
  });

  it("opens_the_scratch_vault_via_the_e2e_seam", async () => {
    // The webdriver build announces SKRIBEUM_E2E_VAULT to the webview,
    // which opens the vault on startup; the tree appears without any
    // dialog interaction.
    const tree = $('[role="tree"]');
    await tree.waitForExist({ timeout: 15000 });
    await $(`li=${LF_NOTE_NAME}`).waitForExist({ timeout: 15000 });
    await $(`li=${CRLF_NOTE_NAME}`).waitForExist({ timeout: 15000 });
  });

  it("reaches_primary_surfaces_by_pointer_at_narrow_viewports", async () => {
    try {
      for (const [width, height] of [
        [360, 640],
        [390, 844],
      ] as const) {
        await setViewportSize(width, height);
        const mobileActions = $('[aria-label="Primary actions"]');
        await mobileActions.waitForDisplayed({ timeout: 10000 });

        const layout = await browser.execute(() => {
          const editor = document.querySelector<HTMLElement>(".cm-content");
          const pane = document.querySelector<HTMLElement>("main > section");
          const sidebar = document.querySelector<HTMLElement>(
            ".skr-desktop-sidebar",
          );
          if (editor === null || pane === null || sidebar === null) {
            return null;
          }
          const style = getComputedStyle(editor);
          return {
            paneWidth: pane.getBoundingClientRect().width,
            contentWidth: editor.getBoundingClientRect().width,
            readingWidth:
              editor.getBoundingClientRect().width -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight),
            sidebarDisplay: getComputedStyle(sidebar).display,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
          };
        });
        expect(layout).not.toBeNull();
        expect(layout?.sidebarDisplay).toBe("none");
        expect(layout?.paneWidth).toBeGreaterThanOrEqual(width - 1);
        expect(layout?.readingWidth).toBeGreaterThanOrEqual(
          (layout?.contentWidth ?? 0) - 49,
        );
        expect(layout?.overflow).toBe(false);

        const launchTargets = await browser.execute(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[aria-label="Primary actions"] button:not(:disabled)',
            ),
          ].map((element) => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }),
        );
        expect(launchTargets.length).toBeGreaterThanOrEqual(4);
        for (const target of launchTargets) {
          expect(target.width).toBeGreaterThanOrEqual(44);
          expect(target.height).toBeGreaterThanOrEqual(44);
        }

        const actionsButton = mobileActions.$("button=Actions");
        await actionsButton.click();
        const actionsSheet = $('[data-testid="overlay-sheet"]');
        await actionsSheet.waitForDisplayed({ timeout: 10000 });
        const paneWidthWithSheet = await browser.execute(
          () =>
            document
              .querySelector<HTMLElement>("main > section")
              ?.getBoundingClientRect().width ?? 0,
        );
        expect(paneWidthWithSheet).toBe(layout?.paneWidth);
        const sheetTargets = await browser.execute(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[data-testid="overlay-sheet"] button:not(:disabled)',
            ),
          ].map((element) => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }),
        );
        for (const target of sheetTargets) {
          expect(target.width).toBeGreaterThanOrEqual(44);
          expect(target.height).toBeGreaterThanOrEqual(44);
        }

        await actionsSheet.$("button=Open settings").click();
        const settings = $('[data-testid="settings-view"]');
        await settings.waitForDisplayed({ timeout: 10000 });
        await settings.$("button=Close").click();
        await settings.waitForExist({ reverse: true, timeout: 10000 });
        await browser.waitUntil(
          () =>
            browser.execute(
              () => document.activeElement?.textContent?.trim() === "Actions",
            ),
          {
            timeout: 10000,
            timeoutMsg: "settings did not restore focus to the Actions button",
          },
        );

        await mobileActions.$("button=Actions").click();
        const saveActionsSheet = $('[data-testid="overlay-sheet"]');
        await saveActionsSheet.waitForDisplayed({ timeout: 10000 });
        await saveActionsSheet.$("button=Save note").click();
        await saveActionsSheet.waitForExist({
          reverse: true,
          timeout: 10000,
        });
        await browser.waitUntil(
          () =>
            browser.execute(
              () => document.activeElement?.textContent?.trim() === "Actions",
            ),
          {
            timeout: 10000,
            timeoutMsg: "Actions did not restore focus after saving",
          },
        );

        await mobileActions.$("button=Search").click();
        const searchInput = $('[role="combobox"]');
        await searchInput.waitForDisplayed({ timeout: 10000 });
        await searchInput.setValue("third");
        const searchResult = $('[role="option"]');
        await searchResult.waitForDisplayed({ timeout: 10000 });
        await searchResult.click();
        await browser.waitUntil(
          async () => (await editorText()).includes("third"),
          { timeout: 15000 },
        );

        const filesButton = mobileActions.$("button=Files");
        await filesButton.click();
        const filesSheet = $('[data-testid="overlay-sheet"]');
        await filesSheet.waitForDisplayed({ timeout: 10000 });
        await filesSheet.$(`li=${VISUAL_NOTE_NAME}`).click();
        await filesSheet.waitForExist({ reverse: true, timeout: 10000 });
        await browser.waitUntil(
          async () => (await editorText()).includes("A room for reading"),
          { timeout: 15000 },
        );
        const properties = $(".skr-properties-toggle");
        expect(await properties.getAttribute("aria-expanded")).toBe("false");
        expect(
          await browser.execute(() =>
            [
              ...document.querySelectorAll<HTMLElement>(
                ".cm-line.cm-skr-frontmatter",
              ),
            ].every((line) => getComputedStyle(line).display === "none"),
          ),
        ).toBe(true);
      }
    } finally {
      await restoreDesktopViewport();
    }
  });

  it("applies_the_prose_font_and_bounds_the_reading_column", async () => {
    await openNoteFromTree(VISUAL_NOTE_NAME);
    await $(".cm-skr-rich-callout").waitForExist({ timeout: 15000 });

    const measurements: Array<{
      label: string;
      viewportWidth: number;
      fontFamily: string;
      proseFontToken: string;
      readingWidth: number;
      minimumWidth: number;
      maximumWidth: number;
      scrollerWidth: number;
      leftGutter: number;
      rightGutter: number;
      viewportLeftGutter: number;
      viewportRightGutter: number;
      contentLeft: number;
      contentRight: number;
      calloutLeft: number;
      calloutRight: number;
    }> = [];

    try {
      for (const [label, width, height] of [
        ["desktop", 1280, 800],
        ["narrow", 390, 844],
      ] as const) {
        await setViewportSize(width, height);
        const measurement = await browser.execute(() => {
          const content = document.querySelector<HTMLElement>(".cm-content");
          const scroller = document.querySelector<HTMLElement>(".cm-scroller");
          const callout = document.querySelector<HTMLElement>(
            ".cm-line.cm-skr-rich-callout",
          );
          if (content === null || scroller === null || callout === null) {
            throw new Error("reading column fixture missing");
          }

          const style = getComputedStyle(content);
          const contentBox = content.getBoundingClientRect();
          const scrollerBox = scroller.getBoundingClientRect();
          const calloutBox = callout.getBoundingClientRect();
          const paddingLeft = Number.parseFloat(style.paddingLeft);
          const paddingRight = Number.parseFloat(style.paddingRight);
          const readingLeft = contentBox.left + paddingLeft;
          const readingRight = contentBox.right - paddingRight;
          const probe = document.createElement("span");
          probe.style.position = "absolute";
          probe.style.visibility = "hidden";
          probe.style.fontFamily = style.fontFamily;
          probe.style.fontSize = style.fontSize;
          probe.style.fontWeight = style.fontWeight;
          probe.style.width = "45ch";
          document.body.append(probe);
          const minimumWidth = probe.getBoundingClientRect().width;
          probe.style.width = "72ch";
          const maximumWidth = probe.getBoundingClientRect().width;
          probe.style.fontFamily = "var(--skr-font-prose)";
          const proseFontToken = getComputedStyle(probe).fontFamily;
          probe.remove();

          return {
            viewportWidth: window.innerWidth,
            fontFamily: style.fontFamily,
            proseFontToken,
            readingWidth: readingRight - readingLeft,
            minimumWidth: Math.min(minimumWidth, contentBox.width - 2 * 24),
            maximumWidth,
            scrollerWidth: scrollerBox.width,
            leftGutter: readingLeft - scrollerBox.left,
            rightGutter: scrollerBox.right - readingRight,
            viewportLeftGutter: readingLeft,
            viewportRightGutter: window.innerWidth - readingRight,
            contentLeft: contentBox.left,
            contentRight: contentBox.right,
            calloutLeft: calloutBox.left,
            calloutRight: calloutBox.right,
          };
        });
        measurements.push({ label, ...measurement });
      }
    } finally {
      await restoreDesktopViewport();
    }

    for (const measurement of measurements) {
      console.info(
        `reading column ${measurement.label}: viewport=${measurement.viewportWidth.toFixed(2)}, measure=${measurement.readingWidth.toFixed(2)}, scroller=${measurement.scrollerWidth.toFixed(2)}, gutters=${measurement.leftGutter.toFixed(2)}/${measurement.rightGutter.toFixed(2)}, viewport-gutters=${measurement.viewportLeftGutter.toFixed(2)}/${measurement.viewportRightGutter.toFixed(2)}, callout=${measurement.calloutLeft.toFixed(2)}/${measurement.calloutRight.toFixed(2)}`,
      );
    }
    for (const measurement of measurements) {
      expect(measurement.fontFamily).toBe(measurement.proseFontToken);
      expect(measurement.readingWidth).toBeLessThan(
        measurement.scrollerWidth - 1,
      );
      expect(measurement.readingWidth).toBeGreaterThanOrEqual(
        measurement.minimumWidth - 1,
      );
      expect(measurement.readingWidth).toBeLessThanOrEqual(
        measurement.maximumWidth + 1,
      );
      expect(measurement.calloutLeft).toBeGreaterThanOrEqual(
        measurement.contentLeft - 0.5,
      );
      expect(measurement.calloutRight).toBeLessThanOrEqual(
        measurement.contentRight + 0.5,
      );
      if (measurement.label === "narrow") {
        expect(measurement.viewportLeftGutter).toBeGreaterThanOrEqual(23.5);
        expect(measurement.viewportRightGutter).toBeGreaterThanOrEqual(23.5);
      }
    }
  });

  it("keeps_major_narrow_surfaces_inside_the_viewport", async () => {
    const surfaces: Array<{
      surface: string;
      escapes: HorizontalEscape[];
    }> = [];

    try {
      await setViewportSize(390, 844);
      const mobileActions = $('[aria-label="Primary actions"]');
      await mobileActions.waitForDisplayed({ timeout: 10000 });

      await mobileActions.$("button=Files").click();
      let sheet = $('[data-testid="overlay-sheet"]');
      await sheet.waitForDisplayed({ timeout: 10000 });
      await sheet.$(`li=${VISUAL_NOTE_NAME}`).click();
      await sheet.waitForExist({ reverse: true, timeout: 10000 });
      await $(".cm-skr-rich-callout").waitForExist({ timeout: 15000 });
      surfaces.push({
        surface: "note",
        escapes: await horizontalViewportEscapes(),
      });

      await mobileActions.$("button=Actions").click();
      sheet = $('[data-testid="overlay-sheet"]');
      await sheet.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "actions sheet",
        escapes: await horizontalViewportEscapes(),
      });

      await sheet.$("button=Open settings").click();
      const settings = $('[data-testid="settings-view"]');
      await settings.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "settings",
        escapes: await horizontalViewportEscapes(),
      });
      await settings.$("button=Close").click();
      await settings.waitForExist({ reverse: true, timeout: 10000 });

      await mobileActions.$("button=Search").click();
      const search = $('[role="combobox"]');
      await search.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "vault search",
        escapes: await horizontalViewportEscapes(),
      });
      await browser.keys(Key.Escape);
      await search.waitForExist({ reverse: true, timeout: 10000 });

      await mobileActions.$("button=Files").click();
      sheet = $('[data-testid="overlay-sheet"]');
      await sheet.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "file tree sheet",
        escapes: await horizontalViewportEscapes(),
      });
      await browser.keys(Key.Escape);
      await sheet.waitForExist({ reverse: true, timeout: 10000 });
    } finally {
      await restoreDesktopViewport();
    }

    expect(surfaces.map(({ surface }) => surface)).toEqual([
      "note",
      "actions sheet",
      "settings",
      "vault search",
      "file tree sheet",
    ]);
    const failures = surfaces.flatMap(({ surface, escapes }) =>
      escapes.map((viewportEscape) => ({ surface, ...viewportEscape })),
    );
    console.info(
      `horizontal viewport escape counts: ${surfaces
        .map(({ surface, escapes }) => `${surface}=${escapes.length}`)
        .join(", ")}`,
    );
    if (failures.length > 0) {
      throw new Error(
        `horizontal viewport escapes: ${JSON.stringify(failures.slice(0, 20))}`,
      );
    }
  });

  it("presents_a_reading_surface_and_captures_both_themes", async () => {
    const originalTheme = await browser.execute(
      () => document.documentElement.dataset.theme ?? "system",
    );
    const originalBytes = noteOnDisk(VISUAL_NOTE_NAME);
    expect(originalBytes).toBe(VISUAL_NOTE_CONTENT);

    await openNoteFromTree(VISUAL_NOTE_NAME);
    await $(".cm-skr-heading-1").waitForExist({ timeout: 15000 });
    const propertiesToggle = $(".skr-properties-toggle");
    await propertiesToggle.waitForExist({ timeout: 10000 });
    expect(await propertiesToggle.getAttribute("aria-expanded")).toBe("false");

    const rawSourceHidden = await browser.execute(() => {
      const lines = [
        ...document.querySelectorAll<HTMLElement>(
          ".cm-line.cm-skr-frontmatter",
        ),
      ];
      return (
        lines.length > 0 &&
        lines.every((line) => getComputedStyle(line).display === "none")
      );
    });
    expect(rawSourceHidden).toBe(true);

    await browser.execute(() =>
      document.querySelector<HTMLElement>(".cm-content")?.focus(),
    );
    await browser.keys(Key.ArrowUp);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              ".cm-line.cm-skr-frontmatter",
            ),
          ].some((line) => getComputedStyle(line).display !== "none"),
        ),
      { timeout: 5000 },
    );
    expect(
      await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>(".skr-properties");
        return panel === null || getComputedStyle(panel).display === "none";
      }),
    ).toBe(true);
    for (let step = 0; step < 12; step += 1) {
      await browser.keys(Key.ArrowDown);
    }
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              ".cm-line.cm-skr-frontmatter",
            ),
          ].every((line) => getComputedStyle(line).display === "none"),
        ),
      { timeout: 5000 },
    );

    const typography = await browser.execute(() => {
      const prose = document.querySelector<HTMLElement>(".cm-content");
      const code = document.querySelector<HTMLElement>(".cm-skr-inline-code");
      const headings = [1, 2, 3].map((level) => {
        const heading = document.querySelector<HTMLElement>(
          `.cm-skr-heading-${level}`,
        );
        const style = heading === null ? null : getComputedStyle(heading);
        return style === null
          ? null
          : [style.fontSize, style.fontWeight, style.color].join("/");
      });
      return {
        proseFont: prose === null ? "" : getComputedStyle(prose).fontFamily,
        codeFont: code === null ? "" : getComputedStyle(code).fontFamily,
        headings,
      };
    });
    expect(typography.proseFont).not.toBe(typography.codeFont);
    expect(new Set(typography.headings).size).toBe(3);
    expect(typography.headings).not.toContain(null);

    mkdirSync(screenshotDirectory, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await clearEditorSelection();
      await applyVisualTheme(theme);
      const caretColor = await browser.execute(() => {
        const content = document.querySelector<HTMLElement>(".cm-content");
        return content === null ? "" : getComputedStyle(content).caretColor;
      });
      expect(caretColor).not.toBe("");
      expect(caretColor).not.toBe("rgba(0, 0, 0, 0)");
      await browser.saveScreenshot(
        path.join(screenshotDirectory, `after-editor-${theme}.png`),
      );

      await propertiesToggle.click();
      await browser.waitUntil(
        async () =>
          (await propertiesToggle.getAttribute("aria-expanded")) === "true",
        { timeout: 5000 },
      );
      const revealDuration = await browser.execute(() => {
        const reveal = document.querySelector<HTMLElement>(
          ".skr-properties-reveal",
        );
        return reveal === null
          ? Number.POSITIVE_INFINITY
          : Number.parseFloat(getComputedStyle(reveal).transitionDuration) *
              1000;
      });
      expect(revealDuration).toBeLessThan(200);
      await browser.pause(180);
      await browser.saveScreenshot(
        path.join(screenshotDirectory, `after-frontmatter-${theme}.png`),
      );

      const rawToggle = $(".skr-raw-toggle");
      await rawToggle.click();
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            [
              ...document.querySelectorAll<HTMLElement>(
                ".cm-line.cm-skr-frontmatter",
              ),
            ].some((line) => getComputedStyle(line).display !== "none"),
          ),
        { timeout: 5000 },
      );
      expect(noteOnDisk(VISUAL_NOTE_NAME)).toBe(originalBytes);
      await rawToggle.click();
      await propertiesToggle.click();
      await browser.waitUntil(
        async () =>
          (await propertiesToggle.getAttribute("aria-expanded")) === "false",
        { timeout: 5000 },
      );

      await selectEditorText("Patient typography");
      await $(".cm-skr-selection-toolbar").waitForExist({ timeout: 5000 });
      await browser.saveScreenshot(
        path.join(screenshotDirectory, `after-toolbar-${theme}.png`),
      );
    }

    expect(noteOnDisk(VISUAL_NOTE_NAME)).toBe(originalBytes);
    await browser.execute((theme: string) => {
      document.documentElement.dataset.theme = theme;
    }, originalTheme);
    await clearEditorSelection();
  });

  it("aligns_block_text_and_wraps_callouts_within_the_reading_measure", async () => {
    await openNoteFromTree(VISUAL_NOTE_NAME);
    await $(".cm-skr-rich-callout").waitForExist({ timeout: 15000 });

    const geometry = await browser.execute(() => {
      const outerContent = document.querySelector<HTMLElement>(
        ".editor > .cm-editor .cm-content",
      );
      if (outerContent === null) {
        throw new Error("editor content missing");
      }
      const heading = outerContent.querySelector<HTMLElement>(
        ".cm-line.cm-skr-heading-1",
      );
      const callout = outerContent.querySelector<HTMLElement>(
        ".cm-skr-rich-callout",
      );
      const listMark =
        outerContent.querySelector<HTMLElement>(".cm-skr-list-mark");
      const listLine = listMark?.closest<HTMLElement>(".cm-line") ?? null;
      const calloutLine = [
        ...outerContent.querySelectorAll<HTMLElement>(
          ".cm-line.cm-skr-rich-callout",
        ),
      ].find((line) => line.textContent?.includes("Callout text follows"));
      const codeLine = outerContent.querySelector<HTMLElement>(
        ".cm-line.cm-skr-code-block",
      );
      let paragraphLine: HTMLElement | null = null;
      for (const element of outerContent.children) {
        if (element.textContent?.includes("Patient typography")) {
          paragraphLine = element as HTMLElement;
          break;
        }
      }
      if (
        heading === null ||
        callout === null ||
        listLine === null ||
        calloutLine === null ||
        codeLine === null ||
        paragraphLine === null
      ) {
        throw new Error("reading geometry fixture missing");
      }

      const headingStyle = getComputedStyle(heading);
      const headingBox = heading.getBoundingClientRect();
      const paragraphStyle = getComputedStyle(paragraphLine);
      const paragraphBox = paragraphLine.getBoundingClientRect();
      const listStyle = getComputedStyle(listLine);
      const listBox = listLine.getBoundingClientRect();
      const calloutLineStyle = getComputedStyle(calloutLine);
      const calloutLineBox = calloutLine.getBoundingClientRect();
      const codeStyle = getComputedStyle(codeLine);
      const codeBox = codeLine.getBoundingClientRect();
      const headingText = [
        ...heading.querySelectorAll<HTMLElement>("span"),
      ].find((element) => element.textContent?.includes("A room for reading"));
      const proseBounds = {
        left: paragraphBox.left + Number.parseFloat(paragraphStyle.paddingLeft),
        right:
          paragraphBox.right - Number.parseFloat(paragraphStyle.paddingRight),
      };
      const calloutBox = callout.getBoundingClientRect();

      return {
        leftEdges: {
          heading:
            headingBox.left + Number.parseFloat(headingStyle.paddingLeft),
          paragraph: proseBounds.left,
          list: listBox.left + Number.parseFloat(listStyle.paddingLeft),
          callout:
            calloutLineBox.left +
            Number.parseFloat(calloutLineStyle.borderLeftWidth) +
            Number.parseFloat(calloutLineStyle.paddingLeft),
          code: codeBox.left + Number.parseFloat(codeStyle.paddingLeft),
        },
        calloutTextBounds: {
          left:
            calloutLineBox.left +
            Number.parseFloat(calloutLineStyle.borderLeftWidth) +
            Number.parseFloat(calloutLineStyle.paddingLeft),
          right:
            calloutLineBox.right -
            Number.parseFloat(calloutLineStyle.paddingRight),
        },
        calloutLineHeight: calloutLineBox.height,
        calloutTextLineHeight: Number.parseFloat(calloutLineStyle.lineHeight),
        calloutBox: { left: calloutBox.left, right: calloutBox.right },
        proseBounds,
        headingTextDecorationLine: getComputedStyle(headingText ?? heading)
          .textDecorationLine,
      };
    });

    const leftEdges = Object.values(geometry.leftEdges);
    const leftEdgeSpread = Math.max(...leftEdges) - Math.min(...leftEdges);
    console.info(
      `reading left edges: ${Object.entries(geometry.leftEdges)
        .map(([block, edge]) => `${block}=${edge.toFixed(2)}`)
        .join(", ")}`,
    );
    expect(leftEdgeSpread).toBeLessThan(1);
    expect(geometry.calloutLineHeight).toBeGreaterThan(
      geometry.calloutTextLineHeight * 1.5,
    );
    expect(geometry.calloutTextBounds.left).toBeGreaterThanOrEqual(
      geometry.proseBounds.left - 1,
    );
    expect(geometry.calloutTextBounds.right).toBeLessThanOrEqual(
      geometry.proseBounds.right + 1,
    );
    expect(geometry.calloutBox.left).toBeLessThan(geometry.proseBounds.left);
    expect(geometry.calloutBox.right).toBeGreaterThan(
      geometry.proseBounds.right,
    );
    expect(geometry.headingTextDecorationLine).toBe("none");
  });

  it("edits_saves_and_reopens_a_note", async () => {
    await openNoteFromTree(LF_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("alpha"),
      {
        timeout: 15000,
      },
    );

    // Type at a real cursor at the end of the first line, then save with
    // the platform save chord.
    await placeCursorAtLineEnd("alpha");
    await $(".cm-content").addValue(" typed");
    await browser.waitUntil(
      async () => (await editorText()).includes("alpha typed"),
      {
        timeout: 15000,
      },
    );
    await browser.keys([modifierKey, "s"]);

    // The file bytes change exactly as typed: the edited line gains the
    // typed text, every other byte is untouched.
    await waitForDisk(LF_NOTE_NAME, "alpha typed\nbeta\ngamma\n");

    // Reopening shows the saved text.
    await openNoteFromTree(CRLF_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("first"),
      {
        timeout: 15000,
      },
    );
    await openNoteFromTree(LF_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("alpha typed"),
      {
        timeout: 15000,
      },
    );
  });

  it("preserves_crlf_terminators_when_editing_another_line", async () => {
    await openNoteFromTree(CRLF_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("second"),
      {
        timeout: 15000,
      },
    );

    await placeCursorAtLineEnd("second");
    await $(".cm-content").addValue("!");
    await browser.keys([modifierKey, "s"]);

    // Every terminator stays CRLF, including on the edited line; only the
    // typed byte was added.
    await waitForDisk(CRLF_NOTE_NAME, "first\r\nsecond!\r\nthird\r\n");
  });

  it("follows_a_wikilink_and_navigates_back", async () => {
    await openNoteFromTree(NAVIGATION_SOURCE_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("Navigation source"),
      { timeout: 15000 },
    );

    const link = $(".cm-skr-wikilink-target");
    await link.waitForExist({ timeout: 15000 });
    await placeCursorAtLineEnd("Navigation source");
    await link.click();
    await browser.waitUntil(
      async () => (await editorText()).includes("Wikilink destination content"),
      { timeout: 15000 },
    );
    expect(await activeElementDescriptor()).not.toContain("cm-content");

    const back = $("button=Back");
    await back.waitForEnabled({ timeout: 15000 });
    await back.click();
    await browser.waitUntil(
      async () => (await editorText()).includes("Navigation source"),
      { timeout: 15000 },
    );

    await browser.execute(() =>
      document.querySelector<HTMLElement>(".cm-content")?.focus(),
    );
    await placeCursorInsideEditorText("zzz-navigation-target");
    await browser.keys([modifierKey, Key.Enter]);
    await browser.waitUntil(
      async () => (await editorText()).includes("Wikilink destination content"),
      { timeout: 15000 },
    );
    expect(await activeElementDescriptor()).not.toContain("cm-content");
  });

  it("opens_vault_search_from_a_tag", async () => {
    await openNoteFromTree(NAVIGATION_SOURCE_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("Navigation source"),
      { timeout: 15000 },
    );
    const tag = $(".cm-skr-tag");
    await tag.waitForExist({ timeout: 15000 });
    await tag.click();

    const input = $('[role="combobox"]');
    await input.waitForExist({ timeout: 10000 });
    expect(await input.getValue()).toBe("#shared");
    await browser.waitUntil(
      async () => (await $$('[role="option"]').length) >= 2,
      { timeout: 20000, timeoutMsg: "tag search did not list its notes" },
    );
    expect(await $("[role=option]").getText()).toContain("shared");
    await browser.keys(Key.Escape);
  });

  it("keyboard_reaches_every_surface_in_order_without_traps", async () => {
    // Focus order is DOM order: no element carries a positive tabindex, so
    // the traversal order is header action, banners when present, tree,
    // editor.
    const tabOrderSound = await browser.execute(() => {
      const positive = [...document.querySelectorAll("[tabindex]")].some(
        (element) => Number(element.getAttribute("tabindex")) > 0,
      );
      const surfaces = [
        document.querySelector("header button"),
        document.querySelector('[role="tree"]'),
        document.querySelector(".cm-content"),
      ];
      const inOrder = surfaces.every((element, index) => {
        if (element === null) {
          return false;
        }
        if (index === 0) {
          return true;
        }
        const previous = surfaces[index - 1];
        return (
          previous !== null &&
          previous !== undefined &&
          (previous.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0
        );
      });
      return !positive && inOrder;
    });
    expect(tabOrderSound).toBe(true);

    // The header action is keyboard-focusable.
    await browser.execute(() => {
      document.querySelector<HTMLElement>("header button")?.focus();
    });
    expect(await activeElementDescriptor()).toContain("button");

    // The tree exposes exactly one roving tabindex stop and arrow keys
    // move it; Enter opens the focused note.
    const firstTreeItem = $('[role="treeitem"]');
    await firstTreeItem.click();
    expect(await activeElementDescriptor()).toContain("treeitem");
    const beforeArrow = await activeElementDescriptor();
    await browser.keys(Key.ArrowDown);
    const afterArrow = await activeElementDescriptor();
    expect(afterArrow).toContain("treeitem");
    expect(afterArrow).not.toBe(beforeArrow);
    expect(afterArrow).toContain(LF_NOTE_NAME);
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      async () => (await editorText()).includes("alpha typed"),
      {
        timeout: 15000,
      },
    );

    // The editor is keyboard-focusable with a visible focus indicator, and
    // typing lands in the document.
    await browser.execute(() => {
      document.querySelector<HTMLElement>(".cm-content")?.focus();
    });
    expect(await activeElementDescriptor()).toContain("cm-content");
    // The cm-focused class needs window focus events that a bare xvfb never
    // delivers, so the visible-focus contract is asserted by applying the
    // class and reading the computed style; keyboard reachability itself is
    // covered by the activeElement assertion above.
    const focusOutlineVisible = await browser.execute(() => {
      const editor = document.querySelector(".cm-editor");
      if (editor === null) {
        return false;
      }
      const hadClass = editor.classList.contains("cm-focused");
      if (!hadClass) {
        editor.classList.add("cm-focused");
      }
      const style = window.getComputedStyle(editor);
      const visible =
        style.outlineStyle !== "none" && style.outlineWidth !== "0px";
      if (!hadClass) {
        editor.classList.remove("cm-focused");
      }
      return visible;
    });
    expect(focusOutlineVisible).toBe(true);
    await $(".cm-content").addValue("zz");
    await browser.waitUntil(async () => (await editorText()).includes("zz"), {
      timeout: 15000,
    });
    // The idle debounce saves without an explicit save chord.
    await browser.waitUntil(() => noteOnDisk(LF_NOTE_NAME).includes("zz"), {
      timeout: 10000,
    });

    // No keyboard trap: no surface captures Tab, so the browser's default
    // focus traversal stays available everywhere. A synthesized keydown
    // cannot trigger that default action itself, so the assertion is that
    // Tab is left uncanceled by every surface's handlers.
    const tabUncanceled = await browser.execute(() => {
      const targets = [
        document.querySelector("header button"),
        document.querySelector('[role="treeitem"]'),
        document.querySelector(".cm-content"),
      ];
      return targets.every((target) => {
        if (target === null) {
          return false;
        }
        const event = new KeyboardEvent("keydown", {
          key: "Tab",
          code: "Tab",
          keyCode: 9,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        return !event.defaultPrevented;
      });
    });
    expect(tabUncanceled).toBe(true);
  });

  it("transitions_the_heading_marker_when_the_cursor_enters", async () => {
    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("Sunrise heading"),
      {
        timeout: 15000,
      },
    );

    const headingMarkerState = () =>
      browser.execute(() => {
        const marker = document.querySelector<HTMLElement>(
          ".cm-skr-heading .cm-skr-reveal-marker",
        );
        if (marker === null) {
          return null;
        }
        const style = getComputedStyle(marker);
        return {
          active: marker.classList.contains("cm-skr-reveal-marker-active"),
          opacity: style.opacity,
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
          transform: style.transform,
          transitionDurations: style.transitionDuration
            .split(",")
            .map((duration) =>
              duration.trim().endsWith("ms")
                ? Number.parseFloat(duration)
                : Number.parseFloat(duration) * 1000,
            ),
        };
      });

    // A fresh note opens with the cursor at offset zero, on the heading
    // line, where cursor-line reveal shows the marker; move the cursor to
    // the body first (a synthesized click alone does not move CodeMirror's
    // selection here, hence the helper), then assert the marker hides.
    await placeCursorAtLineEnd("body text here");
    await browser.waitUntil(
      async () => (await headingMarkerState())?.active === false,
      {
        timeout: 10000,
        timeoutMsg: "heading marker did not hide with the cursor elsewhere",
      },
    );
    const hidden = await headingMarkerState();
    expect(hidden?.opacity).toBe("0");
    expect(hidden?.transform).not.toBe("none");
    expect(hidden?.transitionDurations.every((duration) => duration < 50)).toBe(
      true,
    );
    const followingPositionBefore = await browser.execute(() => {
      const following = [
        ...document.querySelectorAll<HTMLElement>(".cm-line"),
      ].find((line) => line.textContent === "body text here");
      if (following === undefined) {
        throw new Error("following line missing");
      }
      const rect = following.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });

    // Entering the heading line with the cursor reveals the source
    // marker (cursor-line reveal per docs/decoration-rules.md).
    await placeCursorAtLineEnd("Sunrise heading");
    await browser.waitUntil(
      async () => (await headingMarkerState())?.active === true,
      {
        timeout: 10000,
        timeoutMsg: "heading marker did not reveal on cursor entry",
      },
    );
    const revealed = await headingMarkerState();
    expect(revealed?.opacity).toBe("1");
    if (revealed?.reducedMotion) {
      expect(
        revealed.transitionDurations.every((duration) => duration === 0),
      ).toBe(true);
    } else {
      expect(revealed?.transform).not.toBe(hidden?.transform);
      expect(revealed?.transitionDurations).toEqual([49, 49]);
    }
    const followingPositionAfter = await browser.execute(() => {
      const following = [
        ...document.querySelectorAll<HTMLElement>(".cm-line"),
      ].find((line) => line.textContent === "body text here");
      if (following === undefined) {
        throw new Error("following line missing");
      }
      const rect = following.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    expect(followingPositionAfter).toEqual(followingPositionBefore);

    // Leaving the line hides the marker again.
    await placeCursorAtLineEnd("body text here");
    await browser.waitUntil(
      async () => (await headingMarkerState())?.active === false,
      {
        timeout: 10000,
        timeoutMsg: "heading marker did not hide after the cursor left",
      },
    );
  });

  it("cycles_and_sets_task_statuses_through_the_command_palette", async () => {
    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    const checkbox = $(".cm-skr-task-checkbox");
    await checkbox.waitForExist({ timeout: 15000 });
    expect(await checkbox.getAttribute("aria-label")).toBe("Unchecked");

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(".cm-skr-task-control")
        ?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    });
    const listbox = $('[role="listbox"]');
    await listbox.waitForDisplayed({ timeout: 5000 });
    expect(await listbox.$$('[role="option"]').length).toBe(38);

    await checkbox.click();
    await browser.waitUntil(
      () => noteOnDisk(LIVE_PREVIEW_NOTE_NAME).includes("- [/] Review task"),
      { timeout: 10000, timeoutMsg: "task click did not persist" },
    );

    await placeCursorAtLineEnd("Review task");
    await browser.keys([modifierKey, "p"]);
    const input = $('[role="combobox"]');
    await input.waitForExist({ timeout: 10000 });
    await input.addValue("set task status dropped");
    await browser.waitUntil(
      async () => (await $$('[role="option"]').length) === 1,
      { timeout: 10000 },
    );
    expect(await $('[role="option"]').getText()).toContain("Dropped");
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      () => noteOnDisk(LIVE_PREVIEW_NOTE_NAME).includes("- [-] Review task"),
      { timeout: 10000, timeoutMsg: "task command did not persist" },
    );

    await $(".cm-skr-task-checkbox").click();
    await browser.waitUntil(
      () => noteOnDisk(LIVE_PREVIEW_NOTE_NAME) === LIVE_PREVIEW_NOTE_CONTENT,
      { timeout: 10000, timeoutMsg: "task source did not restore" },
    );
  });

  it("maps_callout_clicks_to_one_source_reveal_region", async () => {
    writeFileSync(
      path.join(SCRATCH_VAULT_PATH, REVEAL_NOTE_NAME),
      REVEAL_NOTE_CONTENT,
    );
    await browser.keys([modifierKey, "o"]);
    const quickSwitcher = $('[role="combobox"]');
    await quickSwitcher.waitForExist({ timeout: 10000 });
    await quickSwitcher.addValue(REVEAL_NOTE_NAME);
    await browser.waitUntil(
      async () => (await $$('[role="option"]').length) === 1,
      { timeout: 10000 },
    );
    await browser.keys(Key.Enter);
    await $(".cm-line.cm-skr-rich-callout").waitForExist({ timeout: 15000 });
    const renderedIdentity = await calloutVisualIdentity();
    expect(renderedIdentity?.accent).toBe("cyan");
    expect(renderedIdentity?.revealed).toBe(false);

    const cases: Array<{
      point: RevealClickPoint;
      line: string;
      minimumOffset: number;
      maximumOffset: number;
    }> = [
      {
        point: "top",
        line: "> [!tip] Linked callout",
        minimumOffset: 0,
        maximumOffset: 2,
      },
      {
        point: "title",
        line: "> [!tip] Linked callout",
        minimumOffset: 0,
        maximumOffset: 24,
      },
      {
        point: "body",
        line: "> First body line.",
        minimumOffset: 0,
        maximumOffset: 18,
      },
      {
        point: "bottom",
        line: "> Read [inside link](inside-target).",
        minimumOffset: 0,
        maximumOffset: 37,
      },
    ];

    for (const testCase of cases) {
      await placeCursorAtLineEnd("cursor parking");
      await browser.waitUntil(
        async () =>
          !(await $(
            '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
          ).isExisting()),
        {
          timeout: 10000,
          timeoutMsg: "callout source did not collapse after the cursor left",
        },
      );
      await clickRevealPoint(testCase.point);
      await $(
        '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
      ).waitForExist({
        timeout: 10000,
        timeoutMsg: `${testCase.point} click did not reveal callout source`,
      });
      const cursor = await editorCursor();
      expect(cursor.line).toBe(testCase.line);
      expect(cursor.offset).toBeGreaterThanOrEqual(testCase.minimumOffset);
      expect(cursor.offset).toBeLessThanOrEqual(testCase.maximumOffset);
      const text = await editorText();
      expect(text).toContain("inside-target");
      expect(text).not.toContain("outside-target");
      const revealedIdentity = await calloutVisualIdentity();
      expect(revealedIdentity?.accent).toBe(renderedIdentity?.accent);
      expect(revealedIdentity?.borderLeftColor).toBe(
        renderedIdentity?.borderLeftColor,
      );
      expect(revealedIdentity?.revealed).toBe(true);
    }

    await placeCursorAtLineEnd("cursor parking");
    await browser.waitUntil(
      async () =>
        !(await $(
          '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
        ).isExisting()),
      {
        timeout: 10000,
        timeoutMsg: "callout source did not collapse before outside reveal",
      },
    );
    await placeCursorAtLineEnd("Outside link");
    await browser.waitUntil(
      async () => (await editorText()).includes("outside-target"),
      {
        timeout: 10000,
        timeoutMsg: "outside link did not reveal",
      },
    );
    expect(await $(".cm-line.cm-skr-rich-callout").isExisting()).toBe(true);
    const text = await editorText();
    expect(text).toContain("outside-target");
    expect(text).not.toContain("inside-target");
    const cursor = await editorCursor();
    expect(cursor.line).toBe("[Outside link](outside-target)");
    expect(cursor.offset).toBeGreaterThanOrEqual(0);
    expect(cursor.offset).toBeLessThanOrEqual(30);

    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("body text here"),
      { timeout: 10000 },
    );
    rmSync(path.join(SCRATCH_VAULT_PATH, REVEAL_NOTE_NAME));
  });

  it("keeps_every_live_preview_transition_below_the_motion_ceiling", async () => {
    await openNoteFromTree(MOTION_PREVIEW_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("after motion constructs"),
      { timeout: 15000 },
    );

    const measurements = await browser.execute(() => {
      const classNames = [
        "cm-skr-reveal-marker",
        "cm-skr-reveal-motion cm-skr-reveal-source",
        "cm-skr-reveal-motion cm-skr-reveal-rendered",
      ];
      const prefersReducedMotion = matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      return classNames.map((className) => {
        const element = document.createElement("span");
        element.className = className;
        document.body.append(element);
        const style = getComputedStyle(element);
        const transitionProperties = style.transitionProperty
          .split(",")
          .map((part) => part.trim());
        const transitionMs = style.transitionDuration.split(",").map((part) => {
          const duration = part.trim();
          return duration.endsWith("ms")
            ? Number.parseFloat(duration)
            : Number.parseFloat(duration) * 1000;
        });
        const measurement = {
          className,
          prefersReducedMotion,
          transitionProperties,
          transitionMs,
          effectiveTransitionMs: transitionProperties.map(
            (_, index) => transitionMs[index % transitionMs.length],
          ),
          animationMs: style.animationDuration.split(",").map((part) => {
            const duration = part.trim();
            return duration.endsWith("ms")
              ? Number.parseFloat(duration)
              : Number.parseFloat(duration) * 1000;
          }),
          animationTimingFunction: style.animationTimingFunction,
          transitionTimingFunction: style.transitionTimingFunction,
        };
        element.remove();
        return measurement;
      });
    });

    for (const measurement of measurements) {
      expect(Math.max(...measurement.transitionMs)).toBeLessThan(50);
      for (const easing of measurement.transitionTimingFunction.split(",")) {
        expect(easing.trim()).toBe("linear");
      }
      if (measurement.className !== "cm-skr-reveal-marker") {
        expect(Math.max(...measurement.animationMs)).toBeLessThan(50);
        expect(measurement.animationTimingFunction).toBe("linear");
      }
    }
    const expectedDuration = measurements[0]?.transitionMs[0] ?? 0;
    expect(measurements[0]?.effectiveTransitionMs).toEqual([
      expectedDuration,
      expectedDuration,
    ]);
    expect(measurements[1]?.effectiveTransitionMs).toEqual([
      expectedDuration,
      expectedDuration,
    ]);
    expect(measurements[2]?.effectiveTransitionMs).toEqual([
      expectedDuration,
      expectedDuration,
    ]);
    expect(measurements[1]?.animationMs).toEqual([expectedDuration]);
    expect(measurements[2]?.animationMs).toEqual([expectedDuration]);
  });

  it("makes_live_preview_motion_instant_under_reduced_motion", async () => {
    await openNoteFromTree(MOTION_PREVIEW_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("after motion constructs"),
      { timeout: 15000 },
    );

    const measurements = await browser.execute(() => {
      const reducedStyle = document.createElement("style");
      const mediaRules: string[] = [];
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (
            rule instanceof CSSMediaRule &&
            rule.conditionText.includes("prefers-reduced-motion")
          ) {
            mediaRules.push(
              ...Array.from(rule.cssRules, (nestedRule) => nestedRule.cssText),
            );
          }
        }
      }
      if (mediaRules.length === 0) {
        throw new Error("prefers-reduced-motion rule missing");
      }
      reducedStyle.textContent = mediaRules.join("\n");
      document.head.append(reducedStyle);

      const classNames = [
        "cm-skr-reveal-marker",
        "cm-skr-reveal-motion cm-skr-reveal-source",
        "cm-skr-reveal-motion cm-skr-reveal-rendered",
      ];
      const result = classNames.map((className) => {
        const element = document.createElement("span");
        element.className = className;
        document.body.append(element);
        const style = getComputedStyle(element);
        const measurement = {
          className,
          transitionDuration: style.transitionDuration,
          animationDuration: style.animationDuration,
        };
        element.remove();
        return measurement;
      });
      reducedStyle.remove();
      return result;
    });

    for (const measurement of measurements) {
      for (const duration of measurement.transitionDuration.split(",")) {
        expect(Number.parseFloat(duration)).toBe(0);
      }
      for (const duration of measurement.animationDuration.split(",")) {
        expect(Number.parseFloat(duration)).toBe(0);
      }
    }
  });

  it("surfaces_and_dismisses_the_note_removed_banner_by_keyboard", async () => {
    await openNoteFromTree(LF_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("alpha"),
      {
        timeout: 15000,
      },
    );
    // Leave the write-settle window of any preceding save before removing
    // the note externally, so the removal classifies as an external change
    // rather than an edit of our own write.
    await browser.pause(2000);
    rmSync(path.join(SCRATCH_VAULT_PATH, LF_NOTE_NAME));
    const dismissButton = $('aside[role="alert"] button');
    await dismissButton.waitForExist({ timeout: 20000 });

    // The dismiss control is a native button, reachable by keyboard focus;
    // native buttons activate on Enter and Space by definition, and the
    // synthesized-event driver can only exercise the activation itself as
    // a click.
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('aside[role="alert"] button')
        ?.focus();
    });
    expect(await activeElementDescriptor()).toContain("button");
    await dismissButton.click();
    await browser.waitUntil(
      async () => !(await $('aside[role="alert"] button').isExisting()),
      { timeout: 10000 },
    );
  });
});

// The M3a surfaces. These run after the shell suite, so the scratch
// vault no longer contains the removed note; the specs below use the
// CRLF and live-preview notes exclusively.
describe("skribeum core editing surfaces", () => {
  async function overlayInput() {
    const input = $('[role="combobox"]');
    await input.waitForExist({ timeout: 10000 });
    return input;
  }

  async function closeAnyOverlay() {
    if (await $('[role="combobox"]').isExisting()) {
      await browser.keys(Key.Escape);
      await browser.waitUntil(
        async () => !(await $('[role="combobox"]').isExisting()),
        { timeout: 5000 },
      );
    }
  }

  it("quick_switcher_opens_a_note_end_to_end", async () => {
    await browser.keys([modifierKey, "o"]);
    const input = await overlayInput();
    await input.addValue("crlf");
    await browser.waitUntil(
      async () => (await $$('[role="option"]').length) === 1,
      { timeout: 10000 },
    );
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      async () => (await editorText()).includes("second"),
      { timeout: 15000 },
    );
    // The overlay closed and focus returned to the editor.
    expect(await $('[role="combobox"]').isExisting()).toBe(false);
  });

  it("command_palette_filters_and_runs_the_outline_toggle", async () => {
    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("Sunrise heading"),
      { timeout: 15000 },
    );

    await browser.keys([modifierKey, "p"]);
    const input = await overlayInput();

    // Full keyboard operation: arrows move the active descendant.
    const before = await input.getAttribute("aria-activedescendant");
    await browser.keys(Key.ArrowDown);
    expect(await input.getAttribute("aria-activedescendant")).not.toBe(before);

    await input.addValue("toggle outline");
    await browser.waitUntil(
      async () => {
        const first = $('[role="option"]');
        return (
          (await first.isExisting()) &&
          (await first.getText()).includes("outline")
        );
      },
      { timeout: 10000 },
    );
    await browser.keys(Key.Enter);

    // The outline panel opened as an ARIA tree over the note's headings.
    const outlineItem = $(
      '[role="tree"][aria-label="Outline"] [role="treeitem"]',
    );
    await outlineItem.waitForExist({ timeout: 10000 });
    expect(await outlineItem.getText()).toContain("Sunrise heading");

    // Enter on a focused outline row navigates without mutating the note.
    const textBefore = await editorText();
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(
          '[role="tree"][aria-label="Outline"] [role="treeitem"]',
        )
        ?.focus();
    });
    await browser.keys(Key.Enter);
    expect(await editorText()).toBe(textBefore);

    // Toggle the panel back off through the same registered command.
    await browser.keys([modifierKey, Key.Shift, "o"]);
    await browser.waitUntil(
      async () =>
        !(await $('[role="tree"][aria-label="Outline"]').isExisting()),
      { timeout: 10000 },
    );
  });

  it("in_note_find_counts_matches_and_closes_by_keyboard", async () => {
    await openNoteFromTree(CRLF_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("second"),
      { timeout: 15000 },
    );
    await browser.execute(() => {
      document.querySelector<HTMLElement>(".cm-content")?.focus();
    });
    await browser.keys([modifierKey, "f"]);
    const findInput = $(".cm-skr-find-input");
    await findInput.waitForExist({ timeout: 10000 });
    await findInput.addValue("second");
    await browser.waitUntil(
      async () => {
        const count = $(".cm-skr-find-count");
        return (
          (await count.isExisting()) &&
          (await count.getText()).includes("1 match")
        );
      },
      { timeout: 10000 },
    );
    // Escape inside the panel closes it and returns focus to the editor.
    await browser.keys(Key.Escape);
    await browser.waitUntil(
      async () => !(await $(".cm-skr-find-panel").isExisting()),
      { timeout: 10000 },
    );
    expect(await activeElementDescriptor()).toContain("cm-content");
  });

  /** Reads the persisted font size through IPC (the global Tauri seam). */
  async function persistedFontSize(): Promise<number | string> {
    return browser.executeAsync<number | string, []>((done) => {
      const tauri = (
        window as unknown as {
          __TAURI__?: {
            core: {
              invoke: (name: string) => Promise<{ editor_font_size: number }>;
            };
          };
        }
      ).__TAURI__;
      if (tauri === undefined) {
        done("no-global-tauri");
        return;
      }
      tauri.core
        .invoke("settings_read")
        .then((doc) => done(doc.editor_font_size))
        .catch((error: unknown) => done(String(error)));
    });
  }

  /** Reads the persisted text column width through IPC. */
  async function persistedLineWidth(): Promise<number | string> {
    return browser.executeAsync<number | string, []>((done) => {
      const tauri = (
        window as unknown as {
          __TAURI__?: {
            core: {
              invoke: (name: string) => Promise<{ editor_line_width: number }>;
            };
          };
        }
      ).__TAURI__;
      if (tauri === undefined) {
        done("no-global-tauri");
        return;
      }
      tauri.core
        .invoke("settings_read")
        .then((doc) => done(doc.editor_line_width))
        .catch((error: unknown) => done(String(error)));
    });
  }

  /** Reads the persisted link-preview preference through IPC. */
  async function persistedLinkPreviews(): Promise<boolean | string> {
    return browser.executeAsync<boolean | string, []>((done) => {
      const tauri = (
        window as unknown as {
          __TAURI__?: {
            core: {
              invoke: (name: string) => Promise<{ link_previews: boolean }>;
            };
          };
        }
      ).__TAURI__;
      if (tauri === undefined) {
        done("no-global-tauri");
        return;
      }
      tauri.core
        .invoke("settings_read")
        .then((doc) => done(doc.link_previews))
        .catch((error: unknown) => done(String(error)));
    });
  }

  /** Sets the settings font size through the open dialog's input. */
  async function setFontSizeThroughDialog(value: number) {
    // WebDriver key input does not assign a predictable value to range
    // controls, so set the native value and exercise their real events.
    await browser.execute((nextValue: number) => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="settings-font-size"]',
      );
      if (input === null) throw new Error("font size control missing");
      input.value = String(nextValue);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  }

  /** Sets the text column width through the open dialog's input. */
  async function setLineWidthThroughDialog(value: number) {
    await browser.execute((nextValue: number) => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="settings-line-width"]',
      );
      if (input === null) throw new Error("text column width control missing");
      input.value = String(nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  }

  async function linkPreviewsControl() {
    const checkbox = $('[data-testid="settings-link-previews"]');
    if (!(await checkbox.isExisting())) {
      const search = $('[data-testid="settings-search"]');
      await search.setValue("link previews");
      await checkbox.waitForExist({ timeout: 5000 });
    }
    return checkbox;
  }

  async function setLinkPreviewsThroughDialog(value: boolean) {
    const checkbox = await linkPreviewsControl();
    if ((await checkbox.isSelected()) !== value) {
      await checkbox.click();
    }
  }

  it("settings_round_trip_applies_restart_free_and_persists", async () => {
    // The settings file is the real per-user document; pick a target
    // that differs from the current value and restore it afterwards.
    const original = await persistedFontSize();
    const originalMeasure = await persistedLineWidth();
    expect(typeof original).toBe("number");
    expect(typeof originalMeasure).toBe("number");
    const target = original === 21 ? 22 : 21;
    const targetMeasure = originalMeasure === 72 ? 78 : 72;

    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    await setFontSizeThroughDialog(target);
    await setLineWidthThroughDialog(targetMeasure);

    // Restart-free apply: the editor font size follows immediately.
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const editor = document.querySelector(".cm-editor");
          return editor === null
            ? ""
            : window.getComputedStyle(editor).fontSize;
        })) === `${target}px`,
      { timeout: 10000 },
    );
    expect(
      await browser.execute(() =>
        document.documentElement.style.getPropertyValue("--skr-editor-measure"),
      ),
    ).toBe(String(targetMeasure));

    // Close, then confirm the persisted value by re-reading through IPC
    // and by reopening the dialog.
    await browser.keys(Key.Escape);
    await browser.waitUntil(
      async () => !(await $('[data-testid="settings-view"]').isExisting()),
      { timeout: 5000 },
    );
    await browser.waitUntil(
      async () => (await persistedFontSize()) === target,
      { timeout: 10000, timeoutMsg: "font size did not persist" },
    );
    await browser.waitUntil(
      async () => (await persistedLineWidth()) === targetMeasure,
      { timeout: 10000, timeoutMsg: "text column width did not persist" },
    );

    await browser.keys([modifierKey, ","]);
    await dialog.waitForExist({ timeout: 10000 });
    expect(await $('[data-testid="settings-font-size"]').getValue()).toBe(
      String(target),
    );
    expect(await $('[data-testid="settings-line-width"]').getValue()).toBe(
      String(targetMeasure),
    );

    // Restore the pre-test value through the same UI path.
    await setFontSizeThroughDialog(original as number);
    await setLineWidthThroughDialog(originalMeasure as number);
    await browser.waitUntil(
      async () => (await persistedFontSize()) === original,
      { timeout: 10000 },
    );
    await browser.waitUntil(
      async () => (await persistedLineWidth()) === originalMeasure,
      { timeout: 10000 },
    );
    await browser.keys(Key.Escape);
    await browser.waitUntil(
      async () => !(await $('[data-testid="settings-view"]').isExisting()),
      { timeout: 5000 },
    );
  });

  it("link_preview_setting_changes_affordances_and_persists", async () => {
    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    const original = await persistedLinkPreviews();
    expect(typeof original).toBe("boolean");
    const target = !(original as boolean);

    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    await setLinkPreviewsThroughDialog(target);
    await browser.waitUntil(
      async () => (await persistedLinkPreviews()) === target,
      { timeout: 10000, timeoutMsg: "link preview setting did not persist" },
    );
    await browser.keys(Key.Escape);
    await browser.waitUntil(async () => !(await dialog.isExisting()), {
      timeout: 5000,
    });
    expect(await $("[data-preview-target]").isExisting()).toBe(target);

    await browser.keys([modifierKey, ","]);
    await dialog.waitForExist({ timeout: 10000 });
    expect(await (await linkPreviewsControl()).isSelected()).toBe(target);
    await setLinkPreviewsThroughDialog(original as boolean);
    await browser.waitUntil(
      async () => (await persistedLinkPreviews()) === original,
      { timeout: 10000 },
    );
    await browser.keys(Key.Escape);
    await browser.waitUntil(async () => !(await dialog.isExisting()), {
      timeout: 5000,
    });
  });

  it("ranked_search_finds_notes_with_highlighted_snippets", async () => {
    await browser.keys([modifierKey, Key.Shift, "f"]);
    const input = await overlayInput();
    await input.addValue("third");
    await browser.waitUntil(
      async () => (await $$('[role="option"]').length) > 0,
      {
        timeout: 20000,
        timeoutMsg: "no ranked search results for a known body word",
      },
    );
    const first = $('[role="option"]');
    expect(await first.getText()).toContain("crlf");
    // The snippet highlight renders as element-wrapped text, not markup.
    const highlighted = $('[role="option"] mark');
    await highlighted.waitForExist({ timeout: 5000 });
    expect(await highlighted.getText()).toContain("third");

    await browser.keys(Key.Enter);
    await browser.waitUntil(
      async () => (await editorText()).includes("third"),
      { timeout: 15000 },
    );
    expect(await $('[role="combobox"]').isExisting()).toBe(false);
  });

  it("keyboard_traversal_traps_modals_and_restores_focus", async () => {
    await closeAnyOverlay();

    // The modal palette keeps Tab on its combobox and Escape returns focus
    // to the editor that opened it.
    await browser.keys([modifierKey, "p"]);
    await overlayInput();
    const tabTrapped = await browser.execute(() => {
      const input = document.querySelector('[role="combobox"]');
      if (input === null) {
        return false;
      }
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        code: "Tab",
        keyCode: 9,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      return (
        event.defaultPrevented &&
        input.closest('[role="dialog"]')?.contains(document.activeElement) ===
          true
      );
    });
    expect(tabTrapped).toBe(true);
    await browser.keys(Key.Escape);
    await browser.waitUntil(
      async () => !(await $('[role="combobox"]').isExisting()),
      { timeout: 5000 },
    );
    expect(await activeElementDescriptor()).toContain("cm-content");

    // No element anywhere acquired a positive tabindex.
    const positive = await browser.execute(() =>
      [...document.querySelectorAll("[tabindex]")].some(
        (element) => Number(element.getAttribute("tabindex")) > 0,
      ),
    );
    expect(positive).toBe(false);
  });

  it("switches_the_persisted_theme_live", async () => {
    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    const original = await browser.execute(
      () => document.documentElement.dataset.theme ?? "system",
    );

    await selectTheme("dark");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.documentElement.dataset.theme,
        )) === "dark",
      { timeout: 10000 },
    );
    // Two frames let the style pass apply the flipped dataset before the
    // dark value is recorded; the initial theme may already look dark, so
    // divergence is only asserted between the two forced states below.
    await browser.execute(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const darkBackground = await browser.execute(
      () => getComputedStyle(document.body).backgroundColor,
    );

    await selectTheme("light");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.documentElement.dataset.theme,
        )) === "light",
      { timeout: 10000 },
    );
    // The dataset flips synchronously; the computed background follows on
    // the next style pass, so the change is awaited, not read immediately.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => getComputedStyle(document.body).backgroundColor,
        )) !== darkBackground,
      {
        timeout: 10000,
        timeoutMsg: "light theme background never diverged from dark",
      },
    );

    await selectTheme(original);
    await browser.keys(Key.Escape);
    await browser.waitUntil(
      async () => !(await $('[data-testid="settings-view"]').isExisting()),
      { timeout: 5000 },
    );
  });

  it("renders_math_and_lazy_mermaid_with_inline_errors", async () => {
    await openNoteFromTree(RENDERING_NOTE_NAME);
    await $(".cm-skr-math-inline .katex").waitForExist({ timeout: 15000 });
    await $(".cm-skr-math-block math").waitForExist({ timeout: 15000 });
    await $(".cm-skr-mermaid svg").waitForExist({ timeout: 30000 });
    await $(".cm-skr-mermaid.cm-skr-render-error").waitForExist({
      timeout: 30000,
    });
    expect(await $(".cm-skr-mermaid.cm-skr-render-error").getText()).toContain(
      "Diagram error",
    );
  });

  it("opens_and_operates_the_read_only_canvas_by_keyboard", async () => {
    await openNoteFromTree(CANVAS_FILE_NAME);
    const viewer = $('[data-testid="canvas-view"]');
    await viewer.waitForExist({ timeout: 15000 });
    expect(await viewer.getAttribute("role")).toBe("region");
    expect(await $('[data-node-id="idea"]').getText()).toContain("Stored idea");
    expect(await $('[data-node-id="note"]').getText()).toContain(
      "Sunrise heading",
    );

    const geometry = await browser.execute(() => {
      const node = document.querySelector<HTMLElement>('[data-node-id="note"]');
      return node === null
        ? null
        : {
            left: node.style.left,
            top: node.style.top,
            width: node.style.width,
            height: node.style.height,
          };
    });
    expect(geometry).toEqual({
      left: "360px",
      top: "180px",
      width: "260px",
      height: "160px",
    });
    expect(await $$('[data-edge-id="connection"]').length).toBe(1);

    await browser.execute(() =>
      document
        .querySelector<HTMLElement>('[data-testid="canvas-view"]')
        ?.focus(),
    );
    const before = await viewer.getAttribute("data-camera");
    await browser.keys(Key.ArrowRight);
    expect(await viewer.getAttribute("data-camera")).not.toBe(before);
    await browser.keys("+");
    expect(await viewer.getAttribute("data-camera")).not.toMatch(/,1$/);
    await browser.keys("0");
    expect(await viewer.getAttribute("data-camera")).toBe("24,24,1");
    expect(noteOnDisk(CANVAS_FILE_NAME)).toBe(CANVAS_FILE_CONTENT);
  });

  it("has_zero_axe_violations_on_main_surfaces", async () => {
    await openNoteFromTree(RENDERING_NOTE_NAME);
    await $(".cm-skr-mermaid svg").waitForExist({ timeout: 30000 });
    await expectNoAxeViolations("vault and decorated editor");

    await browser.keys([modifierKey, "p"]);
    await overlayInput();
    await expectNoAxeViolations("command palette");
    await browser.keys(Key.Escape);

    await browser.keys([modifierKey, ","]);
    await $('[data-testid="settings-view"]').waitForExist({ timeout: 10000 });
    await expectNoAxeViolations("settings");
    await browser.keys(Key.Escape);

    await openNoteFromTree(CANVAS_FILE_NAME);
    await $('[data-testid="canvas-view"]').waitForExist({ timeout: 15000 });
    await expectNoAxeViolations("canvas viewer");
  });
});
