import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  DEFAULT_SETTINGS,
  type SettingsDocument,
} from "../../src/lib/features/settingsStore";
import {
  CANVAS_FILE_CONTENT,
  CANVAS_FILE_NAME,
  CRLF_NOTE_NAME,
  LF_NOTE_NAME,
  LIVE_PREVIEW_NOTE_CONTENT,
  LIVE_PREVIEW_NOTE_NAME,
  MOTION_PREVIEW_NOTE_NAME,
  NAVIGATION_SOURCE_NOTE_NAME,
  PHONE_HEADING_NOTE_NAME,
  PHONE_PLAIN_NOTE_NAME,
  RENDERING_NOTE_CONTENT,
  RENDERING_NOTE_NAME,
  REVEAL_NOTE_CONTENT,
  REVEAL_NOTE_NAME,
  SCRATCH_VAULT_PATH,
  TABLE_GEOMETRY_NOTE_CONTENT,
  TAG_COMPLETION_FINAL_LINE,
  TAG_COMPLETION_MIDDLE_LINE,
  TAG_COMPLETION_TARGET_NOTE_CONTENT,
  TAG_COMPLETION_TARGET_NOTE_NAME,
  TAG_DELETE_NOTE_NAME,
  TAG_DELETE_PROBE_NOTE_NAME,
  TAG_REFRESH_NOTE_NAME,
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
const moduleRequire = createRequire(import.meta.url);
// The minified distribution performs the same audit while keeping the
// WebDriver script payload small enough for slower Linux runners.
const axeSource = readFileSync(
  moduleRequire.resolve("axe-core/axe.min.js"),
  "utf8",
);

const modifierKey = process.platform === "darwin" ? Key.Command : Key.Ctrl;
const DEMO_TAG_COMPLETION_BOUNDARY = "Tag completion fixture boundary.";
let demoTagCompletionPrepared = false;

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

async function setSimulatedVisualViewport(
  height: number,
  offsetTop = 0,
): Promise<void> {
  await browser.execute(
    ({ nextHeight, nextOffsetTop }) => {
      type TestViewportWindow = Window & {
        __SKRIBEUM_NATIVE_VISUAL_VIEWPORT__?: PropertyDescriptor;
        __SKRIBEUM_TEST_VISUAL_VIEWPORT__?: EventTarget & {
          height: number;
          offsetLeft: number;
          offsetTop: number;
          width: number;
        };
      };
      const target = window as TestViewportWindow;
      if (target.__SKRIBEUM_TEST_VISUAL_VIEWPORT__ === undefined) {
        target.__SKRIBEUM_NATIVE_VISUAL_VIEWPORT__ =
          Object.getOwnPropertyDescriptor(window, "visualViewport");
        const viewport =
          new EventTarget() as TestViewportWindow["__SKRIBEUM_TEST_VISUAL_VIEWPORT__"];
        if (viewport === undefined) {
          throw new Error("visual viewport test double was not created");
        }
        Object.assign(viewport, {
          height: nextHeight,
          offsetLeft: 0,
          offsetTop: nextOffsetTop,
          width: window.innerWidth,
        });
        target.__SKRIBEUM_TEST_VISUAL_VIEWPORT__ = viewport;
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: viewport,
        });
      }
      const viewport = target.__SKRIBEUM_TEST_VISUAL_VIEWPORT__;
      if (viewport === undefined) {
        throw new Error("visual viewport test double is unavailable");
      }
      viewport.height = nextHeight;
      viewport.offsetTop = nextOffsetTop;
      viewport.width = window.innerWidth;
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    },
    { nextHeight: height, nextOffsetTop: offsetTop },
  );
  await viewportAfterPaint();
}

async function restoreVisualViewport(): Promise<void> {
  await browser.execute(() => {
    type TestViewportWindow = Window & {
      __SKRIBEUM_NATIVE_VISUAL_VIEWPORT__?: PropertyDescriptor;
      __SKRIBEUM_TEST_VISUAL_VIEWPORT__?: EventTarget;
    };
    const target = window as TestViewportWindow;
    const descriptor = target.__SKRIBEUM_NATIVE_VISUAL_VIEWPORT__;
    if (descriptor === undefined) {
      delete (window as Window & { visualViewport?: VisualViewport })
        .visualViewport;
    } else {
      Object.defineProperty(window, "visualViewport", descriptor);
    }
    delete target.__SKRIBEUM_NATIVE_VISUAL_VIEWPORT__;
    delete target.__SKRIBEUM_TEST_VISUAL_VIEWPORT__;
    window.dispatchEvent(new Event("resize"));
  });
  await viewportAfterPaint();
}

async function noteTitleOpacity(): Promise<string> {
  return browser.execute(
    () =>
      getComputedStyle(
        document.querySelector<HTMLElement>('[data-testid="note-title"]') ??
          document.documentElement,
      ).opacity,
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

type TableGeometry = {
  rows: Array<{
    columns: string;
    cellLefts: number[];
    left: number;
    right: number;
    clientWidth: number;
    scrollWidth: number;
    overflowX: string;
  }>;
};

async function renderedTableGeometry(): Promise<TableGeometry[]> {
  return browser.execute(() => {
    const tables: TableGeometry[] = [];
    for (const row of document.querySelectorAll<HTMLElement>(
      ".cm-skr-table-row",
    )) {
      if (row.classList.contains("cm-skr-table-first")) {
        tables.push({ rows: [] });
      }
      const table = tables.at(-1);
      if (table === undefined) {
        throw new Error("table row appears before a table start");
      }
      const box = row.getBoundingClientRect();
      table.rows.push({
        columns: getComputedStyle(row).gridTemplateColumns,
        cellLefts: [
          ...row.querySelectorAll<HTMLElement>(".cm-skr-table-cell"),
        ].map((cell) => cell.getBoundingClientRect().left),
        left: box.left,
        right: box.right,
        clientWidth: row.clientWidth,
        scrollWidth: row.scrollWidth,
        overflowX: getComputedStyle(row).overflowX,
      });
    }
    return tables;
  });
}

async function prepareTableGeometryNote(): Promise<void> {
  await openNoteFromTree(VISUAL_NOTE_NAME);
  await browser.waitUntil(
    async () => (await editorText()).includes("A room for reading"),
    { timeout: 15000, timeoutMsg: "visual note did not open" },
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, RENDERING_NOTE_NAME),
    TABLE_GEOMETRY_NOTE_CONTENT,
  );
  await waitForDisk(RENDERING_NOTE_NAME, TABLE_GEOMETRY_NOTE_CONTENT);
}

async function prepareTagCompletionTarget(): Promise<void> {
  await openNoteFromTree(VISUAL_NOTE_NAME);
  await browser.waitUntil(
    async () => (await editorText()).includes("A room for reading"),
    { timeout: 15000, timeoutMsg: "visual note did not open" },
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, TAG_COMPLETION_TARGET_NOTE_NAME),
    TAG_COMPLETION_TARGET_NOTE_CONTENT,
  );
  await waitForDisk(
    TAG_COMPLETION_TARGET_NOTE_NAME,
    TAG_COMPLETION_TARGET_NOTE_CONTENT,
  );
  await openNoteFromTree(TAG_COMPLETION_TARGET_NOTE_NAME);
  await browser.waitUntil(
    async () =>
      (await editorDocumentText()) === TAG_COMPLETION_TARGET_NOTE_CONTENT,
    {
      timeout: 15000,
      timeoutMsg: "tag completion target did not reach its exact source state",
    },
  );
}

type TagCompletionPosition = "middle" | "final";

function tagCompletionResult(
  position: TagCompletionPosition,
  replacement: string,
): string {
  if (position === "final") {
    return `${TAG_COMPLETION_MIDDLE_LINE}\n\n${TAG_COMPLETION_FINAL_LINE}\n${replacement}`;
  }
  return `${TAG_COMPLETION_MIDDLE_LINE}\n${replacement}\n${TAG_COMPLETION_FINAL_LINE}\n`;
}

async function typeTagCompletionQuery(
  position: TagCompletionPosition = "final",
  query = "ced",
): Promise<void> {
  await placeCursorAtTagCompletionPosition(position);
  await $(".cm-content").addValue("#");
  await $(".cm-content").addValue(query);
  await browser.waitUntil(
    async () => (await $$(".cm-skr-tag-menu [role=option]")).length > 0,
    { timeout: 10000, timeoutMsg: "tag completion menu did not open" },
  );
  // Let autosave refresh the catalog while the completion query is active.
  await browser.pause(800);
}

async function saveAndExpectTagCompletionTarget(expected: string) {
  await browser.keys([modifierKey, "s"]);
  await waitForDisk(TAG_COMPLETION_TARGET_NOTE_NAME, expected);
}

async function editorText(): Promise<string> {
  return $(".cm-content").getText();
}

async function editorDocumentText(): Promise<string> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>(".cm-line")]
      .map((line) => line.textContent ?? "")
      .join("\n"),
  );
}

async function tagCompletionOptionTexts(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll(".cm-skr-tag-menu [role=option]")].map(
      (option) => option.textContent?.trim() ?? "",
    ),
  );
}

type TagCompletionHarness = {
  prepare(): Promise<void>;
  expectResult(expected: string): Promise<void>;
  expectDismissedResult(expected: string): Promise<void>;
};

const packagedTagCompletionHarness: TagCompletionHarness = {
  prepare: prepareTagCompletionTarget,
  async expectResult(expected) {
    expect(await editorDocumentText()).toBe(expected);
    await saveAndExpectTagCompletionTarget(expected);
  },
  async expectDismissedResult(expected) {
    await saveAndExpectTagCompletionTarget(expected);
  },
};

async function verifyTagCompletionAcceptance(harness: TagCompletionHarness) {
  for (const position of ["middle", "final"] as const) {
    for (const chord of [[Key.Enter], [Key.Ctrl, Key.Enter]]) {
      await harness.prepare();
      await typeTagCompletionQuery(position);
      expect(
        await $$(".cm-skr-tag-menu [role=option]").map((item) =>
          item.getText(),
        ),
      ).toEqual(["#project/cedar-room", "#context/outdoors"]);

      await browser.keys(chord);
      await $(".cm-skr-tag-menu").waitForExist({
        reverse: true,
        timeout: 3000,
      });
      await harness.expectResult(
        tagCompletionResult(position, "#project/cedar-room"),
      );
    }
  }
}

async function verifyTagCompletionArrowSelection(
  harness: TagCompletionHarness,
) {
  for (const position of ["middle", "final"] as const) {
    await harness.prepare();
    await typeTagCompletionQuery(position);
    await browser.keys(Key.ArrowDown);
    expect(await $(".cm-skr-tag-menu [aria-selected=true]").getText()).toBe(
      "#context/outdoors",
    );
    await browser.keys(Key.Enter);
    await harness.expectResult(
      tagCompletionResult(position, "#context/outdoors"),
    );

    await harness.prepare();
    await typeTagCompletionQuery(position);
    await browser.keys(Key.ArrowDown);
    expect(await $(".cm-skr-tag-menu [aria-selected=true]").getText()).toBe(
      "#context/outdoors",
    );
    await browser.keys(Key.ArrowUp);
    expect(await $(".cm-skr-tag-menu [aria-selected=true]").getText()).toBe(
      "#project/cedar-room",
    );
    await browser.keys(Key.Enter);
    await harness.expectResult(
      tagCompletionResult(position, "#project/cedar-room"),
    );
  }
}

async function verifyTagCompletionEscape(harness: TagCompletionHarness) {
  for (const position of ["middle", "final"] as const) {
    await harness.prepare();
    await typeTagCompletionQuery(position);
    await browser.keys(Key.Escape);
    await browser.waitUntil(
      async () => !(await $(".cm-skr-tag-menu").isExisting()),
      { timeout: 3000 },
    );
    expect(await editorDocumentText()).not.toContain("#ced");
    await harness.expectDismissedResult(tagCompletionResult(position, ""));
  }
}

function browserDemoUrl(): string {
  const demoUrl = process.env.SKRIBEUM_E2E_DEMO_URL;
  if (demoUrl === undefined) {
    throw new Error("browser demo test server URL is unavailable");
  }
  return demoUrl;
}

async function demoTagCompletionTargetText(): Promise<string | null> {
  const text = await editorDocumentText();
  const start = text.lastIndexOf(TAG_COMPLETION_MIDDLE_LINE);
  const end = text.indexOf(`\n${DEMO_TAG_COMPLETION_BOUNDARY}`, start);
  return start === -1 || end === -1 ? null : text.slice(start, end);
}

async function prepareDemoTagCompletionTarget(): Promise<void> {
  if (!demoTagCompletionPrepared) {
    const targetUrl = new URL(browserDemoUrl());
    targetUrl.searchParams.set("note", "about.md");
    await browser.url(targetUrl.href);
    await $(".demo-shell").waitForExist({ timeout: 15000 });
    await browser.waitUntil(
      async () => (await editorText()).includes("About this vault"),
      { timeout: 15000, timeoutMsg: "browser demo target did not open" },
    );
    await placeCursorAtDocumentEnd();
    await browser.keys(Key.Enter);
    demoTagCompletionPrepared = true;
  } else {
    await browser.pause(800);
    await selectDemoTagCompletionFixture();
  }
  await $(".cm-content").addValue(
    `${TAG_COMPLETION_TARGET_NOTE_CONTENT}\n${DEMO_TAG_COMPLETION_BOUNDARY}`,
  );
  const prepared = await demoTagCompletionTargetText();
  if (prepared !== TAG_COMPLETION_TARGET_NOTE_CONTENT) {
    throw new Error(
      `browser demo target was not prepared: ${JSON.stringify(prepared)}`,
    );
  }
  await browser.pause(800);
}

async function selectDemoTagCompletionFixture(): Promise<void> {
  await browser.execute(
    (firstText: string, lastText: string) => {
      const lines = [...document.querySelectorAll<HTMLElement>(".cm-line")];
      const first = lines.find((line) => line.textContent === firstText);
      const last = lines.find((line) => line.textContent === lastText);
      if (first === undefined || last === undefined) {
        throw new Error("browser demo tag completion fixture is unavailable");
      }
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.childNodes.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    TAG_COMPLETION_MIDDLE_LINE,
    DEMO_TAG_COMPLETION_BOUNDARY,
  );
  await browser.pause(200);
}

const demoTagCompletionHarness: TagCompletionHarness = {
  prepare: prepareDemoTagCompletionTarget,
  async expectResult(expected) {
    expect(await demoTagCompletionTargetText()).toBe(expected);
  },
  async expectDismissedResult(expected) {
    expect(await demoTagCompletionTargetText()).toBe(expected);
  },
};

async function placeCursorAtTagCompletionPosition(
  position: TagCompletionPosition,
) {
  await browser.execute(
    (anchorText: string) => {
      const lines = [...document.querySelectorAll<HTMLElement>(".cm-line")];
      const anchorIndex = lines.findIndex(
        (line) => line.textContent === anchorText,
      );
      const insertionLine = lines[anchorIndex + 1];
      if (
        anchorIndex === -1 ||
        insertionLine === undefined ||
        insertionLine.textContent !== ""
      ) {
        throw new Error("tag completion insertion line is unavailable");
      }
      insertionLine.click();
      const range = document.createRange();
      range.selectNodeContents(insertionLine);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    position === "final"
      ? TAG_COMPLETION_FINAL_LINE
      : TAG_COMPLETION_MIDDLE_LINE,
  );
  await browser.pause(200);
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

async function placeCursorAtDocumentEnd() {
  await browser.execute(() => {
    const line = [...document.querySelectorAll<HTMLElement>(".cm-line")].at(-1);
    if (line === undefined) {
      throw new Error("editor has no final line");
    }
    line.click();
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
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

async function selectSettingsChoice(selector: string, label: string) {
  let button = $(selector);
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await browser.waitUntil(
    async () => {
      button = $(selector);
      return (await button.getAttribute("aria-checked")) === "true";
    },
    { timeout: 10000, timeoutMsg: `${label} did not become active` },
  );
}

async function waitForPersistedDemoSetting(field: string, value: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        ({ expectedField, expectedValue }) => {
          const persisted = JSON.parse(
            localStorage.getItem("skribeum.demo.settings") ?? "{}",
          );
          return persisted[expectedField] === expectedValue;
        },
        { expectedField: field, expectedValue: value },
      ),
    {
      timeout: 10000,
      timeoutMsg: `${field} did not persist as ${value}`,
    },
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
      document.dispatchEvent(new Event("selectionchange"));
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
      document.dispatchEvent(new Event("selectionchange"));
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

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (
      nestedValue === null ||
      typeof nestedValue !== "object" ||
      Array.isArray(nestedValue)
    ) {
      return nestedValue;
    }
    return Object.fromEntries(
      Object.entries(nestedValue).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

async function dispatchFocusedKey(key: string): Promise<boolean> {
  return browser.execute((nextKey: string) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: nextKey,
    });
    active.dispatchEvent(event);
    return event.defaultPrevented;
  }, key);
}

async function expectNoAxeViolations(surface: string) {
  const violations = await browser.executeAsync<
    Array<{ id: string; impact: string | null; targets: string[] }>,
    []
  >(`${axeSource}
const done = arguments[arguments.length - 1];
window.axe.run()
  .then((result) => done(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }))))
  .catch((error) => done([
    { id: String(error), impact: "critical", targets: [] },
  ]));
`);
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

  it("provides_the_phone_shell_overflow_and_scroll_aware_title", async () => {
    await openNoteFromTree(PHONE_HEADING_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("Phone heading"),
      { timeout: 15000, timeoutMsg: "heading-led phone note did not open" },
    );

    try {
      await setViewportSize(390, 844);
      const filesButton = $('button[aria-label="Files"]');
      const overflowButton = $('button[aria-label="More actions"]');
      const title = $('[data-testid="note-title"]');
      await filesButton.waitForDisplayed({ timeout: 10000 });
      await overflowButton.waitForDisplayed({ timeout: 10000 });

      const shell = await browser.execute(() => {
        const header = document.querySelector<HTMLElement>(".skr-app-header");
        const pane = document.querySelector<HTMLElement>("main > section");
        const scroller = document.querySelector<HTMLElement>(".cm-scroller");
        const editor = document.querySelector<HTMLElement>(".cm-content");
        if (
          header === null ||
          pane === null ||
          scroller === null ||
          editor === null
        ) {
          return null;
        }
        const editorStyle = getComputedStyle(editor);
        const visibleRegions = [...header.children]
          .filter((child): child is HTMLElement => child instanceof HTMLElement)
          .filter((child) => {
            const style = getComputedStyle(child);
            const bounds = child.getBoundingClientRect();
            return (
              style.display !== "none" && bounds.width > 0 && bounds.height > 0
            );
          })
          .map((child) => {
            const bounds = child.getBoundingClientRect();
            return {
              className: child.className,
              height: bounds.height,
              width: bounds.width,
            };
          });
        return {
          bottomBarExists:
            document.querySelector(".skr-mobile-actions") !== null,
          headerHeight: header.getBoundingClientRect().height,
          paneWidth: pane.getBoundingClientRect().width,
          scrollbarWidth: scroller.offsetWidth - scroller.clientWidth,
          readingWidth:
            editor.getBoundingClientRect().width -
            Number.parseFloat(editorStyle.paddingLeft) -
            Number.parseFloat(editorStyle.paddingRight),
          visibleRegions,
        };
      });
      expect(shell).not.toBeNull();
      expect(shell?.bottomBarExists).toBe(false);
      expect(shell?.headerHeight).toBe(48);
      expect(shell?.paneWidth).toBeGreaterThanOrEqual(389);
      expect(
        Math.abs(
          (shell?.readingWidth ?? 0) -
            ((shell?.paneWidth ?? 0) - (shell?.scrollbarWidth ?? 0) - 48),
        ),
      ).toBeLessThanOrEqual(1);
      expect(shell?.visibleRegions).toHaveLength(3);
      expect(shell?.visibleRegions[0]?.className).toContain("skr-phone-files");
      expect(shell?.visibleRegions[0]?.width).toBe(44);
      expect(shell?.visibleRegions[0]?.height).toBe(44);
      expect(shell?.visibleRegions[1]?.className).toContain("skr-note-title");
      expect(shell?.visibleRegions[2]?.className).toContain(
        "skr-phone-overflow",
      );
      expect(shell?.visibleRegions[2]?.width).toBe(44);
      expect(shell?.visibleRegions[2]?.height).toBe(44);

      await browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(".cm-scroller");
        if (scroller !== null) {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll"));
        }
      });
      await browser.waitUntil(async () => (await noteTitleOpacity()) === "0", {
        timeout: 5000,
        timeoutMsg: "heading-led title was visible at the top",
      });
      await browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(".cm-scroller");
        if (scroller !== null) {
          scroller.scrollTop = 320;
          scroller.dispatchEvent(new Event("scroll"));
        }
      });
      await browser.waitUntil(async () => (await noteTitleOpacity()) === "1", {
        timeout: 5000,
        timeoutMsg: "title did not appear past the heading",
      });
      expect(await title.getText()).toBe("z-phone-heading");
      await browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(".cm-scroller");
        if (scroller !== null) {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll"));
        }
      });
      await browser.waitUntil(async () => (await noteTitleOpacity()) === "0", {
        timeout: 5000,
        timeoutMsg: "title did not hide above the threshold",
      });

      await overflowButton.click();
      const overflowSheet = $('[data-testid="overlay-sheet"]');
      await overflowSheet.waitForDisplayed({ timeout: 10000 });
      const overflowRows = await browser.execute(() =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".skr-action-menu > button",
          ),
        ].map((button) => ({
          command: button.dataset.commandId ?? null,
          label:
            button.querySelector("span")?.textContent?.trim() ??
            button.textContent?.trim() ??
            "",
        })),
      );
      expect(overflowRows).toEqual([
        { command: "quick-switcher.open", label: "Quick switcher" },
        { command: "vault-search.open", label: "Search" },
        { command: "palette.open", label: "Command palette" },
        { command: "settings.open", label: "Open settings" },
        { command: "outline.toggle", label: "Toggle outline" },
        { command: "file-tree.open", label: "Open file tree" },
        { command: "note.create", label: "Create new note" },
        { command: "note.save", label: "Save note" },
        { command: "find.open", label: "Find in note" },
        { command: "navigation.back", label: "Navigate back" },
        { command: "navigation.forward", label: "Navigate forward" },
        { command: null, label: "Open vault" },
      ]);
      for (const target of await overflowSheet.$$("button:not(:disabled)")) {
        const size = await target.getSize();
        expect(size.height).toBeGreaterThanOrEqual(44);
      }
      await browser.keys(Key.Escape);
      await overflowSheet.waitForExist({ reverse: true, timeout: 10000 });

      for (const [commandId, initialQuery, mode] of [
        ["quick-switcher.open", "", "file"],
        ["vault-search.open", "?", "text"],
        ["palette.open", ">", "command"],
      ] as const) {
        await overflowButton.click();
        await overflowSheet.waitForDisplayed({ timeout: 10000 });
        await overflowSheet.$(`[data-command-id="${commandId}"]`).click();
        const commandSurface = $('[data-testid="unified-command-surface"]');
        await commandSurface.waitForDisplayed({ timeout: 10000 });
        const input = commandSurface.$('[role="combobox"]');
        expect(await input.getValue()).toBe(initialQuery);
        expect(await input.getAttribute("data-search-mode")).toBe(mode);

        if (commandId === "palette.open") {
          const paletteOptions = await commandSurface.$$(
            '[role="option"][data-command-id]',
          );
          const paletteCommandIds = await Promise.all(
            paletteOptions.map((option) => option.getAttribute("data-command-id")),
          );
          expect(paletteCommandIds.length).toBeGreaterThan(50);
          expect(new Set(paletteCommandIds).size).toBe(
            paletteCommandIds.length,
          );
          for (const option of paletteOptions) {
            expect((await option.getSize()).height).toBeGreaterThanOrEqual(44);
          }
          expect(paletteCommandIds).toEqual(
            expect.arrayContaining([
              "settings.open",
              "outline.toggle",
              "file-tree.open",
              "note.create",
              "note.save",
              "find.open",
              "navigation.back",
              "navigation.forward",
            ]),
          );
        }

        await browser.keys(Key.Escape);
        await commandSurface.waitForExist({ reverse: true, timeout: 10000 });
      }

      await filesButton.click();
      const filesSheet = $('[data-testid="overlay-sheet"]');
      await filesSheet.waitForDisplayed({ timeout: 10000 });
      await filesSheet.$(`li=${PHONE_PLAIN_NOTE_NAME}`).click();
      await browser.waitUntil(
        async () =>
          (await editorText()).includes("without an in-document heading"),
        { timeout: 15000, timeoutMsg: "plain phone note did not open" },
      );
      expect(await title.getText()).toBe("z-phone-plain");
      await browser.waitUntil(async () => (await noteTitleOpacity()) === "1", {
        timeout: 5000,
        timeoutMsg: "plain-note title did not finish appearing",
      });
      await browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(".cm-scroller");
        if (scroller !== null) {
          scroller.scrollTop = scroller.scrollHeight;
          scroller.dispatchEvent(new Event("scroll"));
        }
      });
      expect(await noteTitleOpacity()).toBe("1");
      await browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(".cm-scroller");
        if (scroller !== null) {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll"));
        }
      });
    } finally {
      await restoreDesktopViewport();
    }
  });

  it("clamps_keyboard_surfaces_to_the_visual_viewport", async () => {
    await prepareTagCompletionTarget();
    try {
      await setViewportSize(390, 844);
      // Headless browsers do not summon an on-screen keyboard, so this
      // visualViewport reduction reproduces the usable phone area it removes.
      await setSimulatedVisualViewport(360);
      const overflowButton = $('button[aria-label="More actions"]');
      await overflowButton.click();
      const overflowSheet = $('[data-testid="overlay-sheet"]');
      await overflowSheet.waitForDisplayed({ timeout: 10000 });
      await overflowSheet.$('[data-command-id="quick-switcher.open"]').click();
      const picker = $('[data-testid="unified-command-surface"]');
      await picker.waitForDisplayed({ timeout: 10000 });
      let bounds = await browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>(
          '[data-testid="unified-command-surface"] .command-surface-dialog',
        );
        const viewport = window.visualViewport;
        if (dialog === null || viewport === null) return null;
        const rect = dialog.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          top: rect.top,
          viewportBottom: viewport.offsetTop + viewport.height,
          viewportTop: viewport.offsetTop,
        };
      });
      expect(bounds).not.toBeNull();
      expect(bounds?.top).toBe(bounds?.viewportTop);
      expect(bounds?.bottom).toBeLessThanOrEqual(bounds?.viewportBottom ?? 0);

      await setSimulatedVisualViewport(280, 64);
      bounds = await browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>(
          '[data-testid="unified-command-surface"] .command-surface-dialog',
        );
        const viewport = window.visualViewport;
        if (dialog === null || viewport === null) return null;
        const rect = dialog.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          top: rect.top,
          viewportBottom: viewport.offsetTop + viewport.height,
          viewportTop: viewport.offsetTop,
        };
      });
      expect(bounds?.top).toBe(64);
      expect(bounds?.bottom).toBeLessThanOrEqual(344);
      await browser.keys(Key.Escape);
      await picker.waitForExist({ reverse: true, timeout: 10000 });

      await setSimulatedVisualViewport(500);
      await typeTagCompletionQuery("final");
      const caretBottom = await browser.execute(() => {
        const caret = document.querySelector<HTMLElement>(".cm-cursor-primary");
        return caret?.getBoundingClientRect().bottom ?? 140;
      });
      await setSimulatedVisualViewport(Math.ceil(caretBottom + 24));
      const tagGeometry = await browser.execute(() => {
        const menu = document.querySelector<HTMLElement>(".cm-skr-tag-menu");
        const viewport = window.visualViewport;
        if (menu === null || viewport === null) return null;
        const rect = menu.getBoundingClientRect();
        return {
          above: menu.classList.contains("cm-tooltip-above"),
          bottom: rect.bottom,
          top: rect.top,
          viewportBottom: viewport.offsetTop + viewport.height,
          viewportTop: viewport.offsetTop,
        };
      });
      expect(tagGeometry).not.toBeNull();
      expect(tagGeometry?.above).toBe(true);
      expect(tagGeometry?.top).toBeGreaterThanOrEqual(
        tagGeometry?.viewportTop ?? 0,
      );
      expect(tagGeometry?.bottom).toBeLessThanOrEqual(
        tagGeometry?.viewportBottom ?? 0,
      );
      await browser.keys(Key.Escape);
      await browser.keys([modifierKey, "s"]);
      await waitForDisk(
        TAG_COMPLETION_TARGET_NOTE_NAME,
        TAG_COMPLETION_TARGET_NOTE_CONTENT,
      );
    } finally {
      await restoreVisualViewport();
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

  it("shares_rendered_column_geometry_within_each_table", async () => {
    await prepareTableGeometryNote();
    await openNoteFromTree(RENDERING_NOTE_NAME);
    await browser.waitUntil(
      async () =>
        (await editorText()).includes(
          "A second table keeps its own source-derived proportions.",
        ) && (await $$(".cm-skr-table-row")).length === 8,
      { timeout: 15000, timeoutMsg: "table geometry fixture did not render" },
    );

    const measurements: TableGeometry[][] = [];
    const originalFonts = await browser.execute(() => {
      const root = document.documentElement.style;
      const prose = root.getPropertyValue("--skr-font-prose");
      const interfaceFont = root.getPropertyValue("--skr-font-interface");
      root.setProperty("--skr-font-prose", "serif");
      root.setProperty("--skr-font-interface", "monospace");
      return { prose, interfaceFont };
    });
    try {
      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ] as const) {
        await setViewportSize(width, height);
        const tables = await renderedTableGeometry();
        measurements.push(tables);
      }
    } finally {
      await browser.execute(({ prose, interfaceFont }) => {
        const root = document.documentElement.style;
        if (prose === "") {
          root.removeProperty("--skr-font-prose");
        } else {
          root.setProperty("--skr-font-prose", prose);
        }
        if (interfaceFont === "") {
          root.removeProperty("--skr-font-interface");
        } else {
          root.setProperty("--skr-font-interface", interfaceFont);
        }
      }, originalFonts);
      await restoreDesktopViewport();
    }

    for (const tables of measurements) {
      expect(tables).toHaveLength(2);
      expect(tables.map((table) => table.rows.length)).toEqual([4, 4]);

      for (const table of tables) {
        const header = table.rows[0];
        expect(header).toBeDefined();
        expect(new Set(header?.columns.split(" ")).size).toBeGreaterThan(1);
        for (const row of table.rows) {
          expect(row.columns).toBe(header?.columns);
          expect(row.cellLefts).toHaveLength(header?.cellLefts.length ?? 0);
          for (const [index, left] of row.cellLefts.entries()) {
            expect(
              Math.abs(left - (header?.cellLefts[index] ?? left)),
            ).toBeLessThanOrEqual(1);
          }
        }
        for (const row of table.rows) {
          expect(row.overflowX).not.toBe("auto");
          expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
        }
      }
      expect(tables[0]?.rows[0]?.columns).not.toBe(tables[1]?.rows[0]?.columns);
    }
  });

  it("keeps_major_narrow_surfaces_inside_the_viewport", async () => {
    const surfaces: Array<{
      surface: string;
      escapes: HorizontalEscape[];
    }> = [];

    try {
      await prepareTableGeometryNote();
      await setViewportSize(390, 844);
      const filesButton = $('button[aria-label="Files"]');
      const overflowButton = $('button[aria-label="More actions"]');
      await filesButton.waitForDisplayed({ timeout: 10000 });
      await overflowButton.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "phone chrome",
        escapes: await horizontalViewportEscapes(),
      });

      await filesButton.click();
      let sheet = $('[data-testid="overlay-sheet"]');
      await sheet.waitForDisplayed({ timeout: 10000 });
      await sheet.$(`li=${RENDERING_NOTE_NAME}`).click();
      await sheet.waitForExist({ reverse: true, timeout: 10000 });
      await $(".cm-skr-table-row").waitForExist({ timeout: 15000 });
      await browser.waitUntil(
        async () =>
          (await editorText()).includes(
            "A second table keeps its own source-derived proportions.",
          ),
        { timeout: 15000, timeoutMsg: "table-heavy note did not open" },
      );
      surfaces.push({
        surface: "table-heavy note",
        escapes: await horizontalViewportEscapes(),
      });

      await overflowButton.click();
      sheet = $('[data-testid="overlay-sheet"]');
      await sheet.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "overflow sheet",
        escapes: await horizontalViewportEscapes(),
      });

      await sheet.$('[data-command-id="settings.open"]').click();
      const settings = $('[data-testid="settings-view"]');
      await settings.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "settings",
        escapes: await horizontalViewportEscapes(),
      });
      await settings.$('button[aria-label="Close"]').click();
      await settings.waitForExist({ reverse: true, timeout: 10000 });

      await overflowButton.click();
      sheet = $('[data-testid="overlay-sheet"]');
      await sheet.waitForDisplayed({ timeout: 10000 });
      await sheet.$('[data-command-id="vault-search.open"]').click();
      const search = $('[role="combobox"]');
      await search.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "vault search",
        escapes: await horizontalViewportEscapes(),
      });
      await browser.keys(Key.Escape);
      await search.waitForExist({ reverse: true, timeout: 10000 });

      await filesButton.click();
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
      await openNoteFromTree(VISUAL_NOTE_NAME);
      await browser.waitUntil(
        async () => (await editorText()).includes("A room for reading"),
        { timeout: 15000, timeoutMsg: "visual note did not reopen" },
      );
      writeFileSync(
        path.join(SCRATCH_VAULT_PATH, RENDERING_NOTE_NAME),
        RENDERING_NOTE_CONTENT,
      );
      await waitForDisk(RENDERING_NOTE_NAME, RENDERING_NOTE_CONTENT);
    }

    expect(surfaces.map(({ surface }) => surface)).toEqual([
      "phone chrome",
      "table-heavy note",
      "overflow sheet",
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
    await $(".cm-skr-wikilink-target").waitForExist({ timeout: 15000 });

    await browser.execute(() =>
      document.querySelector<HTMLElement>(".cm-content")?.focus(),
    );
    await placeCursorInsideEditorText("zzz-navigation-target");
    await browser.waitUntil(
      async () => {
        await browser.execute(() =>
          document.querySelector<HTMLElement>(".cm-content")?.focus(),
        );
        return (await activeElementDescriptor()).includes("cm-content");
      },
      { timeout: 5000 },
    );
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
    expect(await input.getValue()).toBe("?#shared");
    await browser.waitUntil(
      async () => (await $$('[role="option"]').length) >= 2,
      { timeout: 20000, timeoutMsg: "tag search did not list its notes" },
    );
    expect(await $("[role=option]").getText()).toContain("shared");
    await browser.keys(Key.Escape);
  });

  it("accepts_tag_completion_with_enter_and_control_enter", async () => {
    await verifyTagCompletionAcceptance(packagedTagCompletionHarness);
  });

  it("inserts_the_arrow_selected_tag_mid_document_and_on_the_final_line", async () => {
    await verifyTagCompletionArrowSelection(packagedTagCompletionHarness);
  });

  it("ranks_an_inserted_tag_as_recent", async () => {
    await prepareTagCompletionTarget();
    await typeTagCompletionQuery();
    await browser.keys(Key.ArrowDown);
    await browser.keys(Key.Enter);
    const expected = tagCompletionResult("final", "#context/outdoors");
    expect(await editorDocumentText()).toBe(expected);
    await saveAndExpectTagCompletionTarget(expected);
    await placeCursorAtLineEnd("#context/outdoors");
    await browser.keys(Key.Enter);
    await $(".cm-content").addValue("#");
    await browser.waitUntil(
      async () => {
        const options = await tagCompletionOptionTexts();
        return (
          options[0] === "#context/outdoors" &&
          options.includes("#project/cedar-room")
        );
      },
      {
        timeout: 10000,
        timeoutMsg: "recent tag did not reach the first menu position",
      },
    );
    const recentlyOrdered = await tagCompletionOptionTexts();
    expect(recentlyOrdered[0]).toBe("#context/outdoors");
    expect(recentlyOrdered).toContain("#project/cedar-room");
    expect(recentlyOrdered.indexOf("#context/outdoors")).toBeLessThan(
      recentlyOrdered.indexOf("#project/cedar-room"),
    );
    await browser.keys(Key.Escape);
  });

  it("dismisses_tag_completion_without_leaving_query_text", async () => {
    await verifyTagCompletionEscape(packagedTagCompletionHarness);
  });

  it("refreshes_tag_completion_after_saving_a_new_tag", async () => {
    await openNoteFromTree(TAG_REFRESH_NOTE_NAME);
    const editor = $(".cm-content");
    await editor.waitForDisplayed({ timeout: 15000 });
    await editor.click();
    await editor.addValue(" #catalog-refresh ");
    await browser.waitUntil(
      () => noteOnDisk(TAG_REFRESH_NOTE_NAME).includes("#catalog-refresh"),
      { timeout: 10000 },
    );

    await editor.addValue("#");
    await editor.addValue("catalog-r");
    try {
      await browser.waitUntil(
        async () =>
          (
            await $$(".cm-skr-tag-menu [role=option]").map((item) =>
              item.getText(),
            )
          ).includes("#catalog-refresh"),
        { timeout: 10000 },
      );
    } catch {
      const state = await browser.execute(() => ({
        editor: document.querySelector(".cm-content")?.textContent ?? null,
        menu: document.querySelector(".cm-skr-tag-menu")?.textContent ?? null,
      }));
      throw new Error(
        `tag completion did not refresh: ${JSON.stringify(state)}`,
      );
    }
    expect(await $(".cm-skr-tag-menu [role=option]").getText()).toBe(
      "#catalog-refresh",
    );
  });

  it("refreshes_tag_completion_after_deleting_an_unopened_note", async () => {
    await openNoteFromTree(TAG_DELETE_PROBE_NOTE_NAME);
    const editor = $(".cm-content");
    await editor.waitForDisplayed({ timeout: 15000 });
    await editor.click();
    await editor.addValue(" ");
    await editor.addValue("#");
    await editor.addValue("delete-o");
    await browser.waitUntil(
      async () =>
        (
          await $$(".cm-skr-tag-menu [role=option]").map((item) =>
            item.getText(),
          )
        ).includes("#delete-only"),
      { timeout: 10000 },
    );
    await browser.keys(Key.Escape);

    rmSync(path.join(SCRATCH_VAULT_PATH, TAG_DELETE_NOTE_NAME));
    await $(`li=${TAG_DELETE_NOTE_NAME}`).waitForExist({
      reverse: true,
      timeout: 15000,
    });

    await editor.addValue(" ");
    await editor.addValue("#");
    await editor.addValue("delete-o");
    await browser.waitUntil(
      async () => (await $$(".cm-skr-tag-menu [role=option]")).length === 0,
      { timeout: 10000 },
    );
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
        document.querySelector(
          'header [data-command-id="quick-switcher.open"]',
        ),
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
      document
        .querySelector<HTMLElement>(
          'header [data-command-id="quick-switcher.open"]',
        )
        ?.focus();
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
    let checkbox = $(".cm-skr-task-checkbox");
    await checkbox.waitForExist({ timeout: 15000 });
    expect(await checkbox.getAttribute("aria-label")).toBe("Unchecked");

    const hoverState = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>(".cm-skr-task-control");
      if (host === null) {
        return null;
      }
      const bounds = host.getBoundingClientRect();
      host.dispatchEvent(
        new PointerEvent("pointerenter", {
          bubbles: true,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          pointerType: "mouse",
        }),
      );
      const liveCheckbox = host.querySelector<HTMLElement>(
        ".cm-skr-task-checkbox",
      );
      const listbox = host.querySelector<HTMLElement>('[role="listbox"]');
      const state = {
        expanded: liveCheckbox?.getAttribute("aria-expanded"),
        hidden: listbox?.hidden,
        optionCount: listbox?.querySelectorAll('[role="option"]').length,
      };
      host.dispatchEvent(
        new PointerEvent("pointerleave", {
          bubbles: true,
          clientX: bounds.right + 1,
          clientY: bounds.bottom + 1,
          pointerType: "mouse",
        }),
      );
      return state;
    });
    expect(hoverState).toEqual({
      expanded: "true",
      hidden: false,
      optionCount: 38,
    });

    checkbox = $(".cm-skr-task-checkbox");
    await checkbox.click();
    await browser.waitUntil(
      () => noteOnDisk(LIVE_PREVIEW_NOTE_NAME).includes("- [/] Review task"),
      { timeout: 10000, timeoutMsg: "task click did not persist" },
    );
    await $(".skr-app-header").moveTo();
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [
            ...document.querySelectorAll<HTMLElement>(".cm-skr-task-palette"),
          ].every((palette) => palette.hidden),
        ),
      { timeout: 5000, timeoutMsg: "task palette did not close after hover" },
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

  it("supports_the_task_status_hold_drag_release_gesture", async () => {
    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    const checkbox = $(".cm-skr-task-checkbox");
    await checkbox.waitForExist({ timeout: 15000 });
    type TaskGestureObservation = {
      activeOption: string | null;
      menuGap: boolean;
      menuOpened: boolean;
      noOptionUnderPress: boolean;
    };
    const taskGesture = (
      outcome: "advance" | "cancel" | "dropped",
    ): Promise<TaskGestureObservation> =>
      browser.executeAsync<
        TaskGestureObservation,
        ["advance" | "cancel" | "dropped"]
      >((requestedOutcome, done) => {
        const box = document.querySelector<HTMLElement>(
          ".cm-skr-task-checkbox",
        );
        if (box === null) {
          throw new Error("task checkbox is unavailable");
        }
        const bounds = box.getBoundingClientRect();
        const pressPoint = {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2),
        };
        const pointerId = 41;
        const dispatch = (type: string, x: number, y: number) => {
          box.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
              cancelable: true,
              clientX: x,
              clientY: y,
              isPrimary: true,
              pointerId,
              pointerType: "touch",
            }),
          );
        };
        dispatch("pointerdown", pressPoint.x, pressPoint.y);
        const delay = requestedOutcome === "advance" ? 150 : 550;
        window.setTimeout(() => {
          const menu = document.querySelector<HTMLElement>(
            ".cm-skr-task-palette",
          );
          if (requestedOutcome === "advance") {
            dispatch("pointerup", pressPoint.x, pressPoint.y);
            done({
              activeOption: null,
              menuGap: true,
              menuOpened: menu !== null && !menu.hidden,
              noOptionUnderPress: true,
            });
            return;
          }
          if (menu === null || menu.hidden) {
            done({
              activeOption: null,
              menuGap: false,
              menuOpened: false,
              noOptionUnderPress: false,
            });
            return;
          }
          const menuBounds = menu.getBoundingClientRect();
          const optionAtPress = document
            .elementFromPoint(pressPoint.x, pressPoint.y)
            ?.closest(".cm-skr-task-option");
          const dropped = [
            ...menu.querySelectorAll<HTMLElement>('[role="option"]'),
          ].find((candidate) => candidate.textContent?.includes("Dropped"));
          const target =
            requestedOutcome === "dropped" && dropped !== undefined
              ? dropped.getBoundingClientRect()
              : null;
          const targetPoint =
            target === null
              ? pressPoint
              : {
                  x: Math.round(target.left + target.width / 2),
                  y: Math.round(target.top + target.height / 2),
                };
          dispatch("pointermove", targetPoint.x, targetPoint.y);
          const activeOption = menu.getAttribute("aria-activedescendant");
          dispatch("pointerup", targetPoint.x, targetPoint.y);
          done({
            activeOption,
            menuGap:
              menuBounds.bottom <= pressPoint.y - 12 ||
              menuBounds.top >= pressPoint.y + 12,
            menuOpened: true,
            noOptionUnderPress: optionAtPress === null,
          });
        }, delay);
      }, outcome);

    const shortPress = await taskGesture("advance");
    expect(shortPress.menuOpened).toBe(false);
    await browser.waitUntil(
      () => noteOnDisk(LIVE_PREVIEW_NOTE_NAME).includes("- [/] Review task"),
      { timeout: 10000, timeoutMsg: "short task press did not advance" },
    );
    await $(".cm-skr-task-checkbox").click();
    await $(".cm-skr-task-checkbox").click();
    await waitForDisk(LIVE_PREVIEW_NOTE_NAME, LIVE_PREVIEW_NOTE_CONTENT);
    const droppedGesture = await taskGesture("dropped");
    expect(droppedGesture.menuOpened).toBe(true);
    expect(droppedGesture.noOptionUnderPress).toBe(true);
    expect(droppedGesture.menuGap).toBe(true);
    expect(droppedGesture.activeOption).toContain("option-3");
    await browser.waitUntil(
      () => noteOnDisk(LIVE_PREVIEW_NOTE_NAME).includes("- [-] Review task"),
      { timeout: 10000, timeoutMsg: "task drag release did not apply Dropped" },
    );

    await $(".cm-skr-task-checkbox").click();
    await waitForDisk(LIVE_PREVIEW_NOTE_NAME, LIVE_PREVIEW_NOTE_CONTENT);
    const cancelledGesture = await taskGesture("cancel");
    expect(cancelledGesture.menuOpened).toBe(true);
    expect(cancelledGesture.activeOption).toBeNull();
    await $(".cm-skr-task-palette").waitForDisplayed({
      reverse: true,
      timeout: 5000,
    });
    await browser.pause(700);
    expect(noteOnDisk(LIVE_PREVIEW_NOTE_NAME)).toBe(LIVE_PREVIEW_NOTE_CONTENT);
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
    const revealResult = $(
      '[role="option"][data-result-kind="file"][data-result-group]:not([data-result-group=""])',
    );
    await revealResult.waitForDisplayed({ timeout: 10000 });
    expect(await revealResult.getText()).toContain(
      REVEAL_NOTE_NAME.replace(/\.md$/i, ""),
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
    const noteResult = $(
      '[role="option"][data-result-kind="file"][data-result-group]:not([data-result-group=""])',
    );
    await noteResult.waitForDisplayed({ timeout: 10000 });
    expect((await noteResult.getText()).toLocaleLowerCase()).toContain("crlf");
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

  /** Reads the complete persisted settings document through IPC. */
  async function persistedSettings(): Promise<SettingsDocument | string> {
    return browser.executeAsync<SettingsDocument | string, []>((done) => {
      const tauri = (
        window as unknown as {
          __TAURI__?: {
            core: {
              invoke: (name: string) => Promise<SettingsDocument>;
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
        .then((doc) => done(doc))
        .catch((error: unknown) => done(String(error)));
    });
  }

  /** Persists a complete settings document through IPC. */
  async function persistSettings(document: SettingsDocument): Promise<void> {
    const result = await browser.executeAsync<string, [SettingsDocument]>(
      (nextDocument, done) => {
        const tauri = (
          window as unknown as {
            __TAURI__?: {
              core: {
                invoke: (name: string, args: unknown) => Promise<unknown>;
              };
            };
          }
        ).__TAURI__;
        if (tauri === undefined) {
          done("no-global-tauri");
          return;
        }
        tauri.core
          .invoke("settings_write", { doc: nextDocument })
          .then(() => done("ok"))
          .catch((error: unknown) => done(String(error)));
      },
      document,
    );
    expect(result).toBe("ok");
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

  it("settings_surface_has_one_hierarchy_responsive_swatches_and_keyboard_access", async () => {
    await closeAnyOverlay();
    await $('[role="tree"]').waitForExist({ timeout: 15000 });
    const editor = $(".cm-content");
    await editor.click();
    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForDisplayed({ timeout: 10000 });

    const sectionCounts = await browser.execute(() => {
      const names = [
        "Appearance",
        "Editor",
        "Files",
        "Search",
        "Updates",
        "About",
      ];
      const settings = document.querySelector<HTMLElement>(
        '[data-testid="settings-view"]',
      );
      const visibleText = [
        ...(settings?.querySelectorAll<HTMLElement>("*") ?? []),
      ].filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0
        );
      });
      return Object.fromEntries(
        names.map((name) => [
          name,
          visibleText.filter(
            (element) =>
              element.children.length === 0 &&
              element.textContent?.trim() === name,
          ).length,
        ]),
      );
    });
    expect(sectionCounts).toEqual({
      About: 1,
      Appearance: 1,
      Editor: 1,
      Files: 1,
      Search: 1,
      Updates: 1,
    });

    const search = $('[data-testid="settings-search"]');
    await search.setValue("security scope");
    expect(await $('[data-settings-section="about"]').isDisplayed()).toBe(true);
    expect(await $('[data-settings-section="appearance"]').isExisting()).toBe(
      false,
    );
    await search.clearValue();
    await $('[data-settings-section="appearance"]').waitForDisplayed({
      timeout: 5000,
    });

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="settings-jump"]')
        ?.focus();
    });
    expect(await dispatchFocusedKey("Enter")).toBe(true);
    const jumpMenu = $('[data-testid="settings-jump-menu"]');
    await jumpMenu.waitForDisplayed({ timeout: 5000 });
    const menuTrap = await browser.execute(() => {
      const menu = document.querySelector<HTMLElement>(
        '[data-testid="settings-jump-menu"]',
      );
      const controls = [
        ...(menu?.querySelectorAll<HTMLButtonElement>("button") ?? []),
      ];
      const first = controls[0];
      const last = controls.at(-1);
      if (first === undefined || last === undefined) return false;
      last.focus();
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
      });
      last.dispatchEvent(event);
      return event.defaultPrevented && document.activeElement === first;
    });
    expect(menuTrap).toBe(true);
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="settings-jump-menu"] [role="menuitem"]',
        )
        ?.focus();
    });
    expect(await dispatchFocusedKey("ArrowDown")).toBe(true);
    expect(await dispatchFocusedKey("Enter")).toBe(true);
    await jumpMenu.waitForExist({ reverse: true, timeout: 5000 });
    expect(
      await browser.execute(() => {
        const pane = document.querySelector<HTMLElement>(".settings-content");
        const editorSection = document.querySelector<HTMLElement>(
          '[data-settings-section="editor"]',
        );
        if (pane === null || editorSection === null) return false;
        return (
          pane.scrollTop > 0 &&
          Math.abs(
            editorSection.getBoundingClientRect().top -
              pane.getBoundingClientRect().top,
          ) < 1
        );
      }),
    ).toBe(true);

    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="settings-jump"]')
        ?.click();
    });
    const reopenedJumpMenu = $('[data-testid="settings-jump-menu"]');
    await reopenedJumpMenu.waitForDisplayed({ timeout: 5000 });
    await browser.keys(Key.Escape);
    await reopenedJumpMenu.waitForExist({ reverse: true, timeout: 5000 });
    expect(await activeElementDescriptor()).toContain("jump-button");

    await setViewportSize(390, 844);
    const cardGeometry = await browser.execute(() => {
      const cards = [
        ...document.querySelectorAll<HTMLElement>(
          '[aria-label="Light palette"] .palette-card',
        ),
      ].map((card) => card.getBoundingClientRect());
      const firstTop = cards[0]?.top;
      return {
        count: cards.length,
        firstRow: cards.filter(
          ({ top }) => firstTop !== undefined && Math.abs(top - firstTop) < 1,
        ).length,
      };
    });
    expect(cardGeometry).toEqual({ count: 3, firstRow: 2 });
    expect(await horizontalViewportEscapes()).toEqual([]);

    const previewColors = async () =>
      browser.execute(() => {
        const preview = document.querySelector<HTMLElement>(
          '[data-testid="settings-light-palette-preview"]',
        );
        const heading = preview?.querySelector<HTMLElement>(
          ".palette-live-heading",
        );
        const body = preview?.querySelector<HTMLElement>(".palette-live-body");
        const link = preview?.querySelector<HTMLElement>("a");
        const code = preview?.querySelector<HTMLElement>("code");
        const unchecked = preview?.querySelector<HTMLElement>(
          ".palette-live-task:not(.palette-live-task-complete) .palette-live-box",
        );
        const checked = preview?.querySelector<HTMLElement>(
          ".palette-live-task-complete .palette-live-box",
        );
        if (
          preview === null ||
          heading === null ||
          body === null ||
          link === null ||
          code === null ||
          unchecked === null ||
          checked === null
        ) {
          throw new Error("light palette preview is incomplete");
        }
        return {
          accent: getComputedStyle(checked).backgroundColor,
          body: getComputedStyle(body).color,
          code: getComputedStyle(code).backgroundColor,
          heading: getComputedStyle(heading).color,
          link: getComputedStyle(link).color,
          rule: getComputedStyle(unchecked).borderColor,
          surface: getComputedStyle(preview).backgroundColor,
        };
      });

    const manuscript = $('[data-testid="settings-light-palette-manuscript"]');
    await manuscript.scrollIntoView();
    await selectSettingsChoice(
      '[data-testid="settings-light-palette-manuscript"]',
      "Manuscript palette",
    );
    expect(
      await browser.execute(() => {
        const preview = document.querySelector<HTMLElement>(
          '[data-testid="settings-light-palette-preview"]',
        );
        return {
          body: preview
            ?.querySelector<HTMLElement>(".palette-live-body")
            ?.textContent?.replace(/\s+/gu, " ")
            .trim(),
          heading: preview
            ?.querySelector<HTMLElement>(".palette-live-heading")
            ?.textContent?.trim(),
          tasks: [
            ...(preview?.querySelectorAll<HTMLElement>(".palette-live-task") ??
              []),
          ].map(({ textContent }) => textContent?.replace(/\s+/gu, " ").trim()),
        };
      }),
    ).toEqual({
      body: "Notes read well in every light. skr",
      heading: "Manuscript",
      tasks: ["Draft the outline", "✓ Ship the fix"],
    });
    const manuscriptColors = await previewColors();
    await browser.keys(Key.ArrowRight);
    const studio = $('[data-testid="settings-light-palette-studio"]');
    await browser.waitUntil(
      async () => (await studio.getAttribute("aria-checked")) === "true",
      { timeout: 5000, timeoutMsg: "palette arrow key did not select Studio" },
    );
    const studioColors = await previewColors();
    expect(
      Object.keys(manuscriptColors).filter(
        (key) =>
          manuscriptColors[key as keyof typeof manuscriptColors] !==
          studioColors[key as keyof typeof studioColors],
      ).length,
    ).toBe(7);

    const taskSummary = $(".task-status-editor summary");
    await taskSummary.scrollIntoView();
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(".task-status-editor summary")
        ?.focus();
    });
    // The embedded driver does not run native default actions for synthesized
    // keys. Activating the focused native summary exercises the same browser
    // toggle while the focus assertion covers keyboard reachability.
    await taskSummary.click();
    const keyboardReachability = await browser.execute(() => {
      const dialogElement = document.querySelector<HTMLElement>(
        '[data-testid="settings-view"]',
      );
      if (dialogElement === null) return { count: 0, unreachable: ["dialog"] };
      const controls = [
        ...dialogElement.querySelectorAll<HTMLElement>(
          "a[href], button:not(:disabled), input:not(:disabled), summary",
        ),
      ].filter((control) => {
        const style = getComputedStyle(control);
        const box = control.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0
        );
      });
      const unreachable = controls.flatMap((control) => {
        control.focus();
        const nativeControl = ["A", "BUTTON", "INPUT", "SUMMARY"].includes(
          control.tagName,
        );
        return document.activeElement === control && nativeControl
          ? []
          : [
              `${control.tagName.toLowerCase()}${
                control.getAttribute("data-testid") ?? ""
              }`,
            ];
      });
      return { count: controls.length, unreachable };
    });
    expect(keyboardReachability.count).toBeGreaterThan(40);
    expect(keyboardReachability.unreachable).toEqual([]);

    const dialogTrap = await browser.execute(() => {
      const dialogElement = document.querySelector<HTMLElement>(
        '[data-testid="settings-view"]',
      );
      const focusable = [
        ...(dialogElement?.querySelectorAll<HTMLElement>(
          "a[href], button:not(:disabled), input:not(:disabled), summary",
        ) ?? []),
      ].filter((control) => control.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return false;
      last.focus();
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
      });
      last.dispatchEvent(event);
      return event.defaultPrevented && document.activeElement === first;
    });
    expect(dialogTrap).toBe(true);

    await selectSettingsChoice(
      '[data-testid="settings-light-palette-manuscript"]',
      "Manuscript palette",
    );
    await restoreDesktopViewport();
    await browser.keys(Key.Escape);
    await dialog.waitForExist({ reverse: true, timeout: 5000 });
    expect(await activeElementDescriptor()).toContain("cm-content");
  });

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

  it("packaged_settings_restore_default_appearance_and_persist", async () => {
    const preservedSchemaVersion = 73;
    const nonDefaultSettings: SettingsDocument = {
      ...DEFAULT_SETTINGS,
      schema_version: preservedSchemaVersion,
      animations: false,
      attachment_folder_mode: "folder",
      attachment_folder_path: "media",
      autosave_delay_ms: 900,
      code_font: "classic",
      dark_palette: "graphite",
      default_note_folder: "notes",
      editor_font_size: 20,
      editor_line_height: 190,
      editor_line_width: 84,
      honor_obsidian_config: false,
      indent_style: "tabs",
      indent_width: 4,
      light_palette: "studio",
      link_previews: false,
      prose_font: "sans",
      reveal_markdown_syntax: false,
      search_case_sensitive: true,
      search_note_bodies: false,
      search_result_limit: 75,
      show_invisible_characters: true,
      show_line_numbers: true,
      spell_check: false,
      task_statuses: DEFAULT_SETTINGS.task_statuses.map((status, index) => ({
        ...status,
        name: `Alternative status ${index + 1}`,
      })),
      theme: "dark",
      update_channel: "beta",
      wrap_long_lines: false,
    };
    await persistSettings(nonDefaultSettings);
    await browser.refresh();
    await $('[role="tree"]').waitForExist({ timeout: 15000 });

    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    expect(await persistedSettings()).toEqual(nonDefaultSettings);

    await dialog.$("button=Restore defaults").click();
    const expectedDefaults = {
      ...DEFAULT_SETTINGS,
      schema_version: preservedSchemaVersion,
    };
    await browser.waitUntil(
      async () => {
        const appearance = await browser.execute(() => ({
          animations: document.documentElement.dataset.animations,
          codeFont: document.documentElement.dataset.codeFont,
          theme: document.documentElement.dataset.theme,
          lightPalette: document.documentElement.dataset.lightPalette,
          darkPalette: document.documentElement.dataset.darkPalette,
          proseFont: document.documentElement.dataset.proseFont,
        }));
        const persisted = await persistedSettings();
        return (
          appearance.animations === "true" &&
          appearance.codeFont === "modern" &&
          appearance.theme === "system" &&
          appearance.lightPalette === "manuscript" &&
          appearance.darkPalette === "lamplight" &&
          appearance.proseFont === "serif" &&
          typeof persisted !== "string" &&
          stableJson(persisted) === stableJson(expectedDefaults)
        );
      },
      { timeout: 10000, timeoutMsg: "packaged settings did not restore" },
    );
    expect(await persistedSettings()).toEqual(expectedDefaults);
    await browser.keys(Key.Escape);
    await dialog.waitForExist({ reverse: true, timeout: 5000 });
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

  it("browser_demo_restores_default_appearance_and_persists", async () => {
    await browser.url(browserDemoUrl());
    await $(".demo-shell").waitForExist({ timeout: 15000 });
    await browser.execute(() => {
      localStorage.removeItem("skribeum.demo.settings");
    });
    await browser.refresh();
    await $(".demo-shell").waitForExist({ timeout: 15000 });

    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    await selectTheme("dark");
    await waitForPersistedDemoSetting("theme", "dark");
    await selectSettingsChoice(
      '[data-testid="settings-dark-palette-graphite"]',
      "Graphite palette",
    );
    await waitForPersistedDemoSetting("dark_palette", "graphite");
    await selectSettingsChoice(
      '[data-choice="prose_font-sans"]',
      "System sans prose font",
    );
    await waitForPersistedDemoSetting("prose_font", "sans");
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const persisted = JSON.parse(
            localStorage.getItem("skribeum.demo.settings") ?? "{}",
          );
          return (
            document.documentElement.dataset.theme === "dark" &&
            document.documentElement.dataset.darkPalette === "graphite" &&
            document.documentElement.dataset.proseFont === "sans" &&
            persisted.theme === "dark" &&
            persisted.dark_palette === "graphite" &&
            persisted.prose_font === "sans"
          );
        }),
      { timeout: 10000, timeoutMsg: "browser appearance did not persist" },
    );

    await dialog.$("button=Restore defaults").click();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const persisted = JSON.parse(
            localStorage.getItem("skribeum.demo.settings") ?? "{}",
          );
          return (
            document.documentElement.dataset.theme === "system" &&
            document.documentElement.dataset.lightPalette === "manuscript" &&
            document.documentElement.dataset.darkPalette === "lamplight" &&
            document.documentElement.dataset.proseFont === "serif" &&
            persisted.theme === "system" &&
            persisted.light_palette === "manuscript" &&
            persisted.dark_palette === "lamplight" &&
            persisted.prose_font === "serif"
          );
        }),
      { timeout: 10000, timeoutMsg: "browser settings did not restore" },
    );
  });

  it("browser_demo_keeps_tag_completion_keys_after_autosave_refresh", async () => {
    await verifyTagCompletionAcceptance(demoTagCompletionHarness);
    await verifyTagCompletionArrowSelection(demoTagCompletionHarness);
    await verifyTagCompletionEscape(demoTagCompletionHarness);
  });
});
