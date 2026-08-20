import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import "./windowChrome.spec";
import "./workspace.spec";
import {
  DEFAULT_SETTINGS,
  type SettingsDocument,
} from "../../src/lib/features/settingsStore";
import {
  CANVAS_FILE_CONTENT,
  CANVAS_FILE_NAME,
  CONFIG_FILE_CONTENT,
  CONFIG_FILE_NAME,
  CRLF_NOTE_NAME,
  DESKTOP_EXTERNAL_NOTE_CONTENT,
  DESKTOP_EXTERNAL_NOTE_NAME,
  DESKTOP_UNDO_NOTE_CONTENT,
  DESKTOP_UNDO_NOTE_NAME,
  DIALOG_DELETE_NOTE_NAME,
  DIALOG_RENAME_NOTE_NAME,
  DURABLE_CLEAR_NOTE_CONTENT,
  DURABLE_CLEAR_NOTE_NAME,
  DURABLE_EXTERNAL_NOTE_CONTENT,
  DURABLE_EXTERNAL_NOTE_NAME,
  DURABLE_UNDO_NOTE_CONTENT,
  DURABLE_UNDO_NOTE_NAME,
  IMAGE_FILE_HEIGHT,
  IMAGE_FILE_NAME,
  IMAGE_FILE_WIDTH,
  LF_NOTE_NAME,
  LIVE_PREVIEW_NOTE_CONTENT,
  LIVE_PREVIEW_NOTE_NAME,
  NAVIGATION_SOURCE_NOTE_CONTENT,
  NAVIGATION_SOURCE_NOTE_NAME,
  NAVIGATION_TARGET_NOTE_CONTENT,
  NAVIGATION_TARGET_NOTE_NAME,
  PHONE_HEADING_NOTE_NAME,
  PHONE_PLAIN_NOTE_NAME,
  RENDERING_NOTE_CONTENT,
  RENDERING_NOTE_NAME,
  REVEAL_NOTE_CONTENT,
  REVEAL_NOTE_NAME,
  SCRATCH_EDIT_HISTORY_PATH,
  SCRATCH_SETTINGS_PATH,
  SCRATCH_VAULT_PATH,
  TABLE_EDITING_NOTE_CONTENT,
  TABLE_EDITING_NOTE_NAME,
  TABLE_GEOMETRY_NOTE_CONTENT,
  TAG_COMPLETION_FINAL_LINE,
  TAG_COMPLETION_MIDDLE_LINE,
  TAG_COMPLETION_TARGET_NOTE_CONTENT,
  TAG_COMPLETION_TARGET_NOTE_NAME,
  TAG_DELETE_NOTE_NAME,
  TAG_DELETE_PROBE_NOTE_NAME,
  TAG_REFRESH_NOTE_NAME,
  TASK_TRACKS_NOTE_CONTENT,
  TASK_TRACKS_NOTE_NAME,
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

/**
 * Clears the window CodeMirror's history extension groups adjacent local
 * edits within: @codemirror/commands' `history()` (configured with its
 * default `newGroupDelay: 500`) folds a transaction into the previous undo
 * step whenever it arrives within that window of the last one, and decides
 * this lazily from elapsed wall-clock time when the next transaction
 * lands rather than exposing any "group closed" state to poll. Tests that
 * exercise undo/redo as discrete steps after a local edit call this once
 * the edit's own save has landed (`waitForDisk`), so the following
 * undo/redo lands as its own step instead of merging with the edit.
 */
async function waitForUndoGroupSettle(): Promise<void> {
  await browser.pause(1800);
}

async function waitForEditorDocument(expected: string, message: string) {
  try {
    await browser.waitUntil(
      async () => (await editorDocumentText()).trimEnd() === expected.trimEnd(),
      { timeout: 10000 },
    );
  } catch {
    throw new Error(
      `${message}; got ${JSON.stringify(await editorDocumentText())}`,
    );
  }
}

function editHistoryRecords(name: string): unknown[] {
  try {
    return readFileSync(SCRATCH_EDIT_HISTORY_PATH, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { path?: string })
      .filter((record) => record.path === name);
  } catch {
    return [];
  }
}

async function relaunchPackagedApplication(): Promise<void> {
  await browser.reloadSession();
  await browser.tauri.switchWindow("main");
  await $('[role="tree"]').waitForExist({ timeout: 15000 });
  await $(`[role="treeitem"][data-path="${CRLF_NOTE_NAME}"]`).waitForExist({
    timeout: 15000,
  });
}

async function dismissBannersForPath(name?: string) {
  // A banner here is triggered by an external change (a direct fs write
  // or a conflicting save) and is optional: it may already be showing, it
  // may still be in flight, or none may be coming at all. Poll for one to
  // appear instead of assuming a fixed delay is long enough, but do not
  // treat a timeout as an error since "no banner ever arrives" is a valid
  // outcome this helper must also handle.
  try {
    await browser.waitUntil(
      async () => (await $$('aside[role="alert"]')).length > 0,
      { timeout: 2000, interval: 20 },
    );
  } catch {
    // No banner appeared within the wait window; nothing to dismiss.
  }
  for (const banner of await $$('aside[role="alert"]')) {
    if (name === undefined || (await banner.getText()).includes(name)) {
      const controls = await banner.$$("button");
      await controls.at(-1)?.click();
    }
  }
}

/**
 * Waits for a note switch's scroll and selection restoration to finish.
 *
 * Reopening a note the editor has visited before replays its saved caret
 * and scroll offset (Editor.svelte's `replaceEditorState`), which spans up
 * to two animation frames of `correctScrollOffset` corrections; the editor
 * root carries an inline `visibility: hidden` style for that whole window.
 * A test that reads or overwrites scroll position, selection, or focus
 * immediately after the note-path attribute updates races that in-flight
 * correction, which can silently revert the test's own scroll or focus
 * change once it finally lands. Waiting on this visibility flag (the same
 * signal the app itself gates arrival on) removes the race instead of
 * guessing at a frame count.
 */
async function waitForEditorArrival(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.querySelector<HTMLElement>(".cm-editor")?.style
            .visibility !== "hidden",
      ),
    {
      timeout: 10000,
      timeoutMsg: "editor scroll and selection restoration did not settle",
    },
  );
}

/**
 * Summons a task status menu the way a resting pointer does. The checkbox
 * itself owns the hover, and the menu waits out the shared pointer-rest
 * delay before it appears, so a pass across a task line shows nothing.
 */
async function hoverTaskCheckbox() {
  await browser.execute(() => {
    const box = document.querySelector<HTMLElement>(".cm-skr-task-checkbox");
    if (box === null) throw new Error("task checkbox missing");
    const bounds = box.getBoundingClientRect();
    box.dispatchEvent(
      new PointerEvent("pointerenter", {
        bubbles: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        pointerType: "mouse",
      }),
    );
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.querySelector<HTMLElement>(".cm-skr-task-palette")
            ?.hidden === false,
      ),
    { timeout: 5000, timeoutMsg: "task status menu did not open on hover" },
  );
}

async function openNoteFromTree(name: string) {
  const row = $(`[role="treeitem"][data-path="${name}"]`);
  await row.waitForExist({ timeout: 15000 });
  await row.click();
  try {
    await browser.waitUntil(async () => (await currentNotePath()) === name, {
      timeout: 3000,
    });
  } catch {
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
      name,
    );
    await browser.waitUntil(async () => (await currentNotePath()) === name, {
      timeout: 15000,
      timeoutMsg: `${name} did not become the active note`,
    });
  }
  const isCanvas = name.toLowerCase().endsWith(".canvas");
  const renderedSurfaceSelector = isCanvas
    ? ".skr-editor-pane-focused .skr-pane-content"
    : ".skr-editor-pane-focused .skr-editor-shell";
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, expectedPath) =>
          document.querySelector(selector)?.getAttribute("data-note-path") ===
          expectedPath,
        renderedSurfaceSelector,
        name,
      ),
    {
      timeout: 15000,
      timeoutMsg: `${name} did not finish rendering in the focused pane`,
    },
  );
  if (!isCanvas) {
    await waitForEditorArrival();
  }
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

async function openNoteFromQuickSwitcher(name: string) {
  // Every caller of this helper runs at the default wide viewport, where
  // the overflow button opens the anchored menu, not the narrow-viewport
  // bottom sheet.
  await $('button[aria-label="More actions"]').click();
  const overflow = $('[data-testid="anchored-menu"]');
  await overflow.waitForDisplayed({ timeout: 10000 });
  await overflow.$('[data-command-id="quick-switcher.open"]').click();
  const input = $('[role="combobox"]');
  await input.waitForDisplayed({ timeout: 10000 });
  await input.addValue(name);
  await browser.waitUntil(
    async () => {
      const selected = $('[role="option"][aria-selected="true"]');
      return (
        (await selected.isExisting()) &&
        (await selected.getText()).toLocaleLowerCase().includes(name)
      );
    },
    { timeout: 10000, timeoutMsg: `${name} was not selected` },
  );
  await browser.keys(Key.Enter);
  await input.waitForExist({ reverse: true, timeout: 10000 });
  if (!name.toLowerCase().endsWith(".canvas")) {
    await waitForEditorArrival();
  }
}

async function waitForSurfaceEntrance(selector: string) {
  await browser.waitUntil(
    () =>
      browser.execute((targetSelector) => {
        const target = document.querySelector<HTMLElement>(targetSelector);
        if (target === null) return false;
        const style = getComputedStyle(target);
        return (
          target.dataset.motionEntered === "true" &&
          style.opacity === "1" &&
          style.transform === "none"
        );
      }, selector),
    { timeout: 5000, timeoutMsg: `${selector} entrance did not settle` },
  );
}

type ViewportSize = { width: number; height: number };

type TransitionSnapshot = {
  duration: string;
  properties: string;
};

function effectiveTransitionDuration(
  snapshot: TransitionSnapshot,
  property: string,
): string {
  const properties = snapshot.properties
    .split(",")
    .map((value) => value.trim());
  const durations = snapshot.duration.split(",").map((value) => value.trim());
  const index = properties.findIndex(
    (candidate) => candidate === property || candidate === "all",
  );
  return index < 0 ? "0s" : (durations[index % durations.length] ?? "0s");
}

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
  await openNoteFromTree(TAG_COMPLETION_TARGET_NOTE_NAME);
  await browser.keys([modifierKey, "w"]);
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
  harness: TagCompletionHarness,
  position: TagCompletionPosition = "final",
  query = "ced",
): Promise<void> {
  await placeCursorAtTagCompletionPosition(position);
  await $(".cm-content").addValue("#");
  await $(".cm-content").addValue(query);
  try {
    await browser.waitUntil(
      async () => (await $$(".cm-skr-tag-menu [role=option]")).length > 0,
      { timeout: 10000, timeoutMsg: "tag completion menu did not open" },
    );
  } catch {
    const state = await browser.execute(() => ({
      active: document.activeElement?.className ?? null,
      document: [...document.querySelectorAll<HTMLElement>(".cm-line")]
        .map((line) => line.textContent ?? "")
        .join("\n"),
      selection:
        (
          window as Window & {
            __SKRIBEUM_E2E_HISTORY_STATE__?: () => CapturedHistoryState | null;
          }
        ).__SKRIBEUM_E2E_HISTORY_STATE__?.() ?? null,
    }));
    throw new Error(
      `tag completion menu did not open: ${JSON.stringify(state)}`,
    );
  }
  // Exercise the tag menu surviving a concurrent catalog refresh: typing
  // the query dirties the note, autosave's onSaved callback triggers
  // refreshTagCatalog(), and the menu must not be disrupted by that
  // refresh while it is open. Wait for the autosave itself to land (the
  // event that triggers the refresh) rather than a fixed duration guessed
  // to outlast the debounce.
  await harness.waitForQuerySaved(position, query);
}

async function saveAndExpectTagCompletionTarget(expected: string) {
  await browser.keys([modifierKey, "s"]);
  await waitForDisk(TAG_COMPLETION_TARGET_NOTE_NAME, expected);
}

async function editorText(): Promise<string> {
  // The rendered text only spans CodeMirror's virtualized viewport; a note
  // switch that is still replaying its saved scroll (see
  // waitForEditorArrival) can leave the target content outside that
  // viewport until the restoration settles.
  await waitForEditorArrival();
  return $(".skr-editor-pane-focused .cm-content").getText();
}

type CapturedHistoryState = {
  anchor: number;
  head: number;
  scrollAnchor: number;
  scrollOffset: number;
  propertiesExpanded: boolean;
};

async function capturedHistoryState(): Promise<CapturedHistoryState | null> {
  return browser.execute(
    () =>
      (
        window as Window & {
          __SKRIBEUM_E2E_HISTORY_STATE__?: () => CapturedHistoryState | null;
        }
      ).__SKRIBEUM_E2E_HISTORY_STATE__?.() ?? null,
  );
}

type RestoredHistoryState = {
  state: CapturedHistoryState | null;
  /** CSS pixels between the viewport and where the expected state puts it. */
  drift: number | null;
  /** The coarsest scroll position an engine holds, in CSS pixels. */
  positionTolerance: number;
};

async function restoredHistoryState(
  expected: CapturedHistoryState,
): Promise<RestoredHistoryState> {
  return browser.execute((wanted: CapturedHistoryState) => {
    const probe = window as Window & {
      __SKRIBEUM_E2E_HISTORY_STATE__?: () => CapturedHistoryState | null;
      __SKRIBEUM_E2E_READING_DRIFT__?: (
        state: CapturedHistoryState,
      ) => number | null;
    };
    return {
      state: probe.__SKRIBEUM_E2E_HISTORY_STATE__?.() ?? null,
      drift: probe.__SKRIBEUM_E2E_READING_DRIFT__?.(wanted) ?? null,
      positionTolerance: Math.max(1, 1 / window.devicePixelRatio),
    };
  }, expected);
}

/**
 * Waits for a restored note to carry the caret and panel state it was stored
 * with, and to sit where the stored reading position puts it.
 *
 * The reading position is compared as a distance rather than as an equal
 * anchor and offset, because the stored anchor line and its sub-pixel offset
 * are one of several encodings of one place. A scroller holds a position only
 * to whole pixels, so restoring into a layout that has changed since the
 * position was stored, as this test's webview zoom makes it, lands within half
 * a pixel of the stored position rather than on it, and the line the position
 * is then anchored to can be its neighbour. A pixel is the whole budget: a
 * position restored to the wrong line misses by a line height.
 */
async function waitForRestoredHistoryState(
  expected: CapturedHistoryState,
  description: string,
): Promise<void> {
  let actual: CapturedHistoryState | null = null;
  let restored: RestoredHistoryState | null = null;
  try {
    await browser.waitUntil(
      async () => {
        restored = await restoredHistoryState(expected);
        actual = restored.state;
        return (
          actual?.anchor === expected.anchor &&
          actual.head === expected.head &&
          actual.propertiesExpanded === expected.propertiesExpanded &&
          restored.drift !== null &&
          Math.abs(restored.drift) <= restored.positionTolerance
        );
      },
      { timeout: 5000, timeoutMsg: description },
    );
  } catch {
    const geometry = await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      const content = document.querySelector<HTMLElement>(".cm-content");
      return {
        scrollTop: scroller?.scrollTop ?? null,
        paddingTop:
          content === null ? null : getComputedStyle(content).paddingTop,
        devicePixelRatio: window.devicePixelRatio,
      };
    });
    throw new Error(
      `${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} at ${JSON.stringify(restored)} with ${JSON.stringify(geometry)}`,
    );
  }
}

async function editorDocumentText(): Promise<string> {
  // See editorText: only rendered lines are queried, and the viewport can
  // still be mid-restoration immediately after a note switch.
  await waitForEditorArrival();
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
  /**
   * Resolves once the autosave carrying the typed query has landed in
   * whichever store the harness persists to.
   */
  waitForQuerySaved(
    position: TagCompletionPosition,
    query: string,
  ): Promise<void>;
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
  async waitForQuerySaved(position, query) {
    // The desktop shell writes the note itself, so the file is the
    // authoritative record that the save landed, and a failure reports the
    // content that did arrive rather than a bare flag.
    await waitForDisk(
      TAG_COMPLETION_TARGET_NOTE_NAME,
      tagCompletionResult(position, `#${query}`),
    );
  },
};

async function verifyTagCompletionAcceptance(harness: TagCompletionHarness) {
  for (const position of ["middle", "final"] as const) {
    for (const chord of [[Key.Enter], [Key.Ctrl, Key.Enter]]) {
      await harness.prepare();
      await typeTagCompletionQuery(harness, position);
      expect(await tagCompletionOptionTexts()).toEqual([
        "#project/cedar-room",
        "#context/outdoors",
      ]);

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
    await typeTagCompletionQuery(harness, position);
    await browser.keys(Key.ArrowDown);
    expect(await $(".cm-skr-tag-menu [aria-selected=true]").getText()).toBe(
      "#context/outdoors",
    );
    await browser.keys(Key.Enter);
    await harness.expectResult(
      tagCompletionResult(position, "#context/outdoors"),
    );

    await harness.prepare();
    await typeTagCompletionQuery(harness, position);
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
    await typeTagCompletionQuery(harness, position);
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

let browserDemoNavigationId = 0;

/**
 * Opens a fresh browser-demo document and waits for that exact navigation to
 * commit. `browser.url()` can resolve while WebKit still paints the preceding
 * document, whose matching shell and editor satisfy the generic readiness
 * checks. A per-navigation query token survives note-address normalization, so
 * the fixture never sends input to a page that is about to be replaced.
 */
async function openBrowserDemo(url: string | URL): Promise<void> {
  const target = new URL(url);
  const navigationId = String(++browserDemoNavigationId);
  target.searchParams.set("e2e-navigation", navigationId);
  await browser.url(target.href);
  await browser.waitUntil(
    () =>
      browser.execute((expectedNavigationId) => {
        type DemoWindow = Window & {
          __SKRIBEUM_E2E_CURRENT_PATH__?: () => string | null;
          __SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?: (
            sourceText: string,
            relativeOffset: number,
          ) => number | null;
          __SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__?: () => boolean | null;
        };
        const content = document.querySelector<HTMLElement>(".cm-content");
        const text = content?.textContent ?? "";
        const harness = window as DemoWindow;
        return (
          document.readyState === "complete" &&
          new URL(window.location.href).searchParams.get("e2e-navigation") ===
            expectedNavigationId &&
          document.querySelector(".demo-shell") !== null &&
          content !== null &&
          content.getClientRects().length > 0 &&
          text.trim().length > 0 &&
          !text.includes("scaffold fixture") &&
          typeof harness.__SKRIBEUM_E2E_CURRENT_PATH__ === "function" &&
          harness.__SKRIBEUM_E2E_CURRENT_PATH__() !== null &&
          typeof harness.__SKRIBEUM_E2E_SET_FROM_LAST_MATCH__ === "function" &&
          typeof harness.__SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__ === "function"
        );
      }, navigationId),
    {
      timeout: 30000,
      timeoutMsg: "browser demo did not commit its requested ready document",
    },
  );
}

async function demoTagCompletionTargetText(): Promise<string | null> {
  const text = await editorDocumentText();
  const start = text.lastIndexOf(TAG_COMPLETION_MIDDLE_LINE);
  const end = text.indexOf(`\n${DEMO_TAG_COMPLETION_BOUNDARY}`, start);
  return start === -1 || end === -1 ? null : text.slice(start, end);
}

/**
 * Waits for the focused pane's active tab to leave the dirty/saving state,
 * i.e. for autosave to have actually landed. The browser demo persists to
 * browser storage rather than a filesystem path `waitForDisk` can read, so
 * this polls the same dirty/saving signal TabStrip's unsaved indicator
 * renders from, exposed directly because the tab strip itself only shows
 * that indicator once a pane holds more than one tab.
 *
 * The wait carries the same budget as `waitForDisk`: both bound one
 * autosave, which spans the idle debounce, a durable-history flush and the
 * write itself, serialized behind any save already in flight. A timeout
 * reports the last state the probe returned, so a write still running
 * (`true`) reads differently from a pane with no active tab (`null`) or a
 * page that never installed the probe.
 */
async function waitForActiveTabSaved(requireDirty = false): Promise<void> {
  let observed: boolean | null | undefined;
  let sawDirty = false;
  try {
    await browser.waitUntil(
      async () => {
        observed = await browser.execute(() =>
          (
            window as Window & {
              __SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__?: () => boolean | null;
            }
          ).__SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__?.(),
        );
        sawDirty ||= observed === true;
        return observed === false && (!requireDirty || sawDirty);
      },
      { timeout: 10000 },
    );
  } catch {
    throw new Error(
      `autosave did not settle: the active tab dirty probe reported ${
        observed === undefined ? "no probe on the page" : String(observed)
      }${requireDirty && !sawDirty ? " without observing the edit" : ""}`,
    );
  }
}

async function prepareDemoTagCompletionTarget(): Promise<void> {
  const targetUrl = new URL(browserDemoUrl());
  targetUrl.searchParams.set("note", "about.md");
  targetUrl.searchParams.set("tag-fixture", Date.now().toString());
  await openBrowserDemo(targetUrl);
  await browser.waitUntil(
    async () => (await editorText()).includes("About this vault"),
    { timeout: 15000, timeoutMsg: "browser demo target did not open" },
  );
  await placeCursorAtDocumentEnd();
  await browser.keys(Key.Enter);
  await $(".cm-content").addValue(
    `${TAG_COMPLETION_TARGET_NOTE_CONTENT}\n${DEMO_TAG_COMPLETION_BOUNDARY}`,
  );
  const prepared = await demoTagCompletionTargetText();
  if (prepared !== TAG_COMPLETION_TARGET_NOTE_CONTENT) {
    throw new Error(
      `browser demo target was not prepared: ${JSON.stringify(prepared)}`,
    );
  }
  // The next call navigates away (a fresh browser.url() for the next
  // prepare() cycle); wait for this edit to actually reach persistent
  // storage first so that navigation cannot race an in-flight write.
  await waitForActiveTabSaved(true);
}

const demoTagCompletionHarness: TagCompletionHarness = {
  prepare: prepareDemoTagCompletionTarget,
  async expectResult(expected) {
    expect(await demoTagCompletionTargetText()).toBe(expected);
  },
  async expectDismissedResult(expected) {
    expect(await demoTagCompletionTargetText()).toBe(expected);
  },
  async waitForQuerySaved() {
    // The demo persists to browser storage, which the test process cannot
    // read, so the tab's own dirty signal is the available oracle.
    await waitForActiveTabSaved(true);
  },
};

async function placeCursorAtTagCompletionPosition(
  position: TagCompletionPosition,
) {
  const relativeOffset =
    position === "final"
      ? TAG_COMPLETION_TARGET_NOTE_CONTENT.length
      : TAG_COMPLETION_MIDDLE_LINE.length + 1;
  let anchor: number | null = null;
  await browser.waitUntil(
    async () => {
      const value = await browser.execute(
        (sourceText: string, offset: number) => {
          return (
            window as Window & {
              __SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?: (
                sourceText: string,
                relativeOffset: number,
              ) => number | null;
            }
          ).__SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?.(sourceText, offset);
        },
        TAG_COMPLETION_MIDDLE_LINE,
        relativeOffset,
      );
      if (typeof value !== "number") return false;
      anchor = value;
      return true;
    },
    {
      timeout: 5000,
      timeoutMsg: "tag completion target line was not selectable",
    },
  );
  expect(typeof anchor).toBe("number");
  await browser.waitUntil(
    async () => (await capturedHistoryState())?.anchor === anchor,
    { timeout: 3000, timeoutMsg: "tag completion cursor was not positioned" },
  );
}

/**
 * Confirms the editor content DOM actually holds document focus after a
 * cursor-placement dispatch's own `view.focus()` call. That call updates
 * `document.activeElement` synchronously in the page's own script realm,
 * but WebKitGTK can deliver the underlying native focus change to the
 * embedded webview asynchronously, the same class of race
 * activeElementDescriptor's callers poll for after a click-triggered focus
 * elsewhere in this file. Under CPU contention the gap is wide enough that
 * a following addValue's synthesized keystrokes can arrive before the
 * webview treats the editor as focused and are silently dropped rather
 * than inserted into the document, so cursor placement waits for this
 * before returning instead of assuming the script-realm focus is enough.
 */
async function waitForEditorFocus(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        () => document.activeElement?.classList.contains("cm-content") ?? false,
      ),
    {
      timeout: 2000,
      timeoutMsg: "editor did not receive focus after cursor placement",
    },
  );
}

/**
 * Places the browser selection at the end of the editor line with `text`,
 * through the same __SKRIBEUM_E2E_SET_LINE_END__ dispatch as before (an
 * earlier version of this helper polled capturedHistoryState()'s anchor to
 * confirm the position landed, but that reports a UTF-8 byte offset
 * (captureHistoryState in src/lib/Editor.svelte converts through
 * byteOffsetForCharacter) while this dispatch's returned anchor is a
 * CodeMirror UTF-16 code-unit position; the two only coincide for
 * documents with no multibyte characters before the target line, which
 * made the wait fail once a table or emoji appeared earlier in the note).
 */
async function placeCursorAtLineEnd(text: string) {
  const anchor = await browser.execute((lineText: string) => {
    return (
      window as Window & {
        __SKRIBEUM_E2E_SET_LINE_END__?: (lineText: string) => number | null;
      }
    ).__SKRIBEUM_E2E_SET_LINE_END__?.(lineText);
  }, text);
  if (typeof anchor !== "number") {
    throw new Error(`no editor line with text ${text}`);
  }
  await waitForEditorFocus();
}

async function placeCursorAtDocumentEnd() {
  // Routes through the same __SKRIBEUM_E2E_SET_SELECTION__ dispatch the
  // other cursor-placement helpers use (an anchor beyond the document
  // clamps to its end) instead of writing the native browser Selection
  // directly.
  const placed = await browser.execute(() =>
    (
      window as Window & {
        __SKRIBEUM_E2E_SET_SELECTION__?: (anchor: number) => boolean;
      }
    ).__SKRIBEUM_E2E_SET_SELECTION__?.(Number.MAX_SAFE_INTEGER),
  );
  if (placed !== true) {
    throw new Error("editor has no document to place a cursor in");
  }
  await waitForEditorFocus();
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
  // The caller polls for the callout's data-revealed attribute right
  // after this returns; that wait already covers the click's async
  // reveal, so no extra settle time is needed here.
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

async function selectSettingsChoice(selector: string, label: string) {
  const button = $(selector);
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await browser.waitUntil(
    () =>
      browser.execute(
        (targetSelector) =>
          document
            .querySelector(targetSelector)
            ?.getAttribute("aria-checked") === "true",
        selector,
      ),
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

/**
 * Places (or extends) the editor selection relative to the last match of
 * `text` in the document, through the same __SKRIBEUM_E2E_SET_FROM_LAST_MATCH__
 * dispatch placeCursorAtTagCompletionPosition uses. A CodeMirror dispatch
 * updates the content DOM selection synchronously as part of applying the
 * transaction, and the selection-toolbar and callout-reveal UI react to
 * CodeMirror's own update cycle rather than a native `selectionchange`
 * listener, so no wait for those is needed afterward (this replaced a raw
 * `window.getSelection()` walk that manually dispatched a synthetic
 * `selectionchange` event to nudge that UI and then paused for it to catch
 * up, which was both slower and less reliable than dispatching through
 * CodeMirror directly). Callers that follow this with typed input still
 * need waitForEditorFocus: see its docstring for why.
 */
async function dispatchSelectionFromLastMatch(
  text: string,
  relativeOffset: number,
  relativeSelectionLength?: number,
): Promise<void> {
  const anchor = await browser.execute(
    (needle: string, offset: number, selectionLength?: number) =>
      (
        window as Window & {
          __SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?: (
            sourceText: string,
            relativeOffset: number,
            relativeSelectionLength?: number,
          ) => number | null;
        }
      ).__SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?.(needle, offset, selectionLength),
    text,
    relativeOffset,
    relativeSelectionLength,
  );
  if (typeof anchor !== "number") {
    throw new Error(`text not found: ${text}`);
  }
  await waitForEditorFocus();
}

async function selectEditorText(text: string): Promise<void> {
  await dispatchSelectionFromLastMatch(text, 0, text.length);
}

async function placeCursorInsideEditorText(text: string): Promise<void> {
  await dispatchSelectionFromLastMatch(text, Math.floor(text.length / 2));
}

async function placeCursorAtEditorTextStart(text: string): Promise<void> {
  await dispatchSelectionFromLastMatch(text, 0);
}

async function clearEditorSelection() {
  if (await $(".cm-skr-selection-toolbar").isExisting()) {
    await browser.execute(() =>
      document.querySelector<HTMLElement>(".cm-content")?.focus(),
    );
    await browser.keys(Key.Escape);
  }
  await browser.execute(() => {
    const root = document.querySelector(".cm-content");
    if (root instanceof HTMLElement) root.focus();
    const line = root?.querySelector(".cm-line:not(.cm-skr-frontmatter)");
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
  await browser.execute(() =>
    document
      .querySelector<HTMLElement>('[data-testid="reading-surface"]')
      ?.focus({ preventScroll: true }),
  );
  await browser.execute(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
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

async function readingSurfaceFocusState(): Promise<{
  readingSurface: boolean;
  editorFocused: boolean;
}> {
  return browser.execute(() => ({
    readingSurface:
      document.activeElement?.matches('[data-testid="reading-surface"]') ===
      true,
    editorFocused:
      document.querySelector(".cm-editor")?.classList.contains("cm-focused") ===
      true,
  }));
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

async function pressFocusedKey(key: string, shiftKey = false): Promise<void> {
  if (!shiftKey) {
    await browser.keys(key);
    return;
  }
  await browser.performActions([
    {
      type: "key",
      id: "focused-keyboard",
      actions: [
        { type: "keyDown", value: Key.Shift },
        { type: "keyDown", value: key },
        { type: "keyUp", value: key },
        { type: "keyUp", value: Key.Shift },
      ],
    },
  ]);
  await browser.releaseActions();
}

async function pressEditorHistoryShortcut(
  direction: "undo" | "redo",
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest(".cm-content")) {
          return true;
        }
        document.querySelector<HTMLElement>(".cm-content")?.focus();
        const focused = document.activeElement;
        return (
          focused instanceof HTMLElement &&
          focused.closest(".cm-content") !== null
        );
      }),
    {
      timeout: 5000,
      timeoutMsg: "editor did not receive keyboard focus",
    },
  );
  const handled = await browser.execute(
    ({ isMac, direction }) => {
      const target = document.activeElement;
      if (!(target instanceof HTMLElement)) {
        throw new Error("editor does not own keyboard focus");
      }
      const redo = direction === "redo";
      const key = redo && !isMac ? "y" : "z";
      const options: KeyboardEventInit = {
        bubbles: true,
        cancelable: true,
        code: key === "y" ? "KeyY" : "KeyZ",
        ctrlKey: !isMac,
        key,
        metaKey: isMac,
        shiftKey: redo && isMac,
      };
      const keyDown = new KeyboardEvent("keydown", options);
      target.dispatchEvent(keyDown);
      target.dispatchEvent(new KeyboardEvent("keyup", options));
      return keyDown.defaultPrevented;
    },
    { isMac: process.platform === "darwin", direction },
  );
  expect(handled).toBe(true);
}

/**
 * Waits for a [data-motion-surface] element's entrance transition to reach
 * its settled state (see enterMotionSurface in src/lib/motion.ts).
 *
 * An axe scan needs it because the color-contrast rule reads the actually
 * rendered opacity: a scan mid-fade can see text still translucent against
 * its background and report a violation that clears on its own well
 * before a human ever perceives it. A click needs it because an anchored
 * surface travels while it arrives, so a row's position at the moment
 * WebDriver resolves it is not its position at the moment the click is
 * dispatched.
 */
async function waitForMotionSurfaceEntered(selector: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((target: string) => {
        const element = document.querySelector<HTMLElement>(target);
        if (element === null) return false;
        const style = getComputedStyle(element);
        return (
          element.dataset.motionEntered === "true" &&
          style.opacity === "1" &&
          style.transform === "none"
        );
      }, selector),
    {
      timeout: 5000,
      timeoutMsg: `${selector} entrance did not settle before an axe scan`,
    },
  );
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
    await $(`[role="treeitem"][data-path="${LF_NOTE_NAME}"]`).waitForExist({
      timeout: 15000,
    });
    await $(`[role="treeitem"][data-path="${CRLF_NOTE_NAME}"]`).waitForExist({
      timeout: 15000,
    });
  });

  it("changes_and_persists_effective_webview_zoom_from_registered_keys", async () => {
    const initialWidth = await browser.execute(() => window.innerWidth);
    await browser.keys([modifierKey, "+"]);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.innerWidth)) < initialWidth,
      { timeoutMsg: "zoom in did not change the effective webview width" },
    );
    expect(
      JSON.parse(readFileSync(SCRATCH_SETTINGS_PATH, "utf8")).zoom_percent,
    ).toBe(110);

    await browser.keys([modifierKey, "-"]);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.innerWidth)) === initialWidth,
      { timeoutMsg: "zoom out did not restore the effective webview width" },
    );
    expect(
      JSON.parse(readFileSync(SCRATCH_SETTINGS_PATH, "utf8")).zoom_percent,
    ).toBe(100);

    await browser.keys([modifierKey, "-"]);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.innerWidth)) > initialWidth,
      { timeoutMsg: "zoom out did not increase the effective webview width" },
    );
    expect(
      JSON.parse(readFileSync(SCRATCH_SETTINGS_PATH, "utf8")).zoom_percent,
    ).toBe(90);

    await browser.keys([modifierKey, "0"]);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.innerWidth)) === initialWidth,
      { timeoutMsg: "zoom reset did not restore the effective webview width" },
    );
    expect(
      JSON.parse(readFileSync(SCRATCH_SETTINGS_PATH, "utf8")).zoom_percent,
    ).toBe(100);
  });

  it("forwards_an_argv_open_path_from_a_second_packaged_instance", async () => {
    const name = "argv-open.txt";
    const file = path.join(SCRATCH_VAULT_PATH, name);
    writeFileSync(file, "Argv open path content.\n", "utf8");
    const binary = process.env.SKRIBEUM_E2E_BINARY;
    if (binary === undefined)
      throw new Error("packaged application path missing");
    execFileSync(binary, [file], {
      env: process.env,
      stdio: "ignore",
      timeout: 15000,
    });
    try {
      await browser.waitUntil(
        async () => {
          const editor = $(".cm-content");
          return (
            (await editor.isExisting()) &&
            (await editor.getText()).includes("Argv open path content.")
          );
        },
        { timeout: 15000 },
      );
    } catch {
      const diagnostics = await browser.execute(async () => {
        const internals = (
          window as Window & {
            __TAURI_INTERNALS__?: {
              invoke(command: string): Promise<string[]>;
            };
          }
        ).__TAURI_INTERNALS__;
        const pending =
          internals === undefined
            ? []
            : await internals.invoke("open_files_take");
        return {
          pendingCount: pending.length,
          editorPresent: document.querySelector(".cm-content") !== null,
          alerts: [...document.querySelectorAll('[role="alert"]')].map(
            (alert) => alert.textContent?.trim() ?? "",
          ),
        };
      });
      throw new Error(
        `argv file-open request was not forwarded: ${JSON.stringify(diagnostics)}`,
      );
    }
  });

  it("composes_the_desktop_header_and_routes_former_header_commands_through_overflow", async () => {
    await restoreDesktopViewport();
    await openNoteFromTree(VISUAL_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("A room for reading"),
      { timeout: 15000, timeoutMsg: "visual note did not open" },
    );

    const header = await browser.execute(() => {
      const root = document.querySelector<HTMLElement>(".skr-app-header");
      if (root === null) return null;
      return {
        regions: [...root.children].map((child) => child.className),
        buttons: [...root.querySelectorAll<HTMLButtonElement>("button")]
          .filter((button) => {
            const bounds = button.getBoundingClientRect();
            return (
              getComputedStyle(button).display !== "none" && bounds.width > 0
            );
          })
          .map((button) => ({
            ariaLabel: button.getAttribute("aria-label"),
            label: button.textContent?.trim() ?? "",
          })),
      };
    });
    expect(header?.regions).toEqual([
      "skr-header-leading",
      "skr-note-title-region",
      "skr-header-trailing",
    ]);
    // macOS keeps its native traffic lights and draws no caption buttons
    // (design system section 4.13); Windows and Linux draw three after the
    // overflow button.
    const captionButtonCount = process.platform === "darwin" ? 0 : 3;
    expect(header?.buttons.map((button) => button.label)).toEqual(
      Array(3 + captionButtonCount).fill(""),
    );
    const captionAriaLabels =
      captionButtonCount === 0
        ? []
        : ["Minimize", "Maximize or restore", "Close"];
    expect(header?.buttons.map((button) => button.ariaLabel)).toEqual([
      "Back",
      "Forward",
      "More actions",
      ...captionAriaLabels,
    ]);
    expect(await $("[data-testid=note-title]").getText()).toBe(
      "A room for reading",
    );
    expect(await horizontalViewportEscapes()).toEqual([]);

    const routes = [
      ["quick-switcher.open", ""],
      ["vault-search.open", "?"],
      ["palette.open", ">"],
    ] as const;
    for (const [command, query] of routes) {
      await $('button[aria-label="More actions"]').click();
      const menu = $('[data-testid="anchored-menu"]');
      await menu.waitForDisplayed({ timeout: 10000 });
      expect(await menu.getAttribute("role")).toBe("menu");
      expect(await horizontalViewportEscapes()).toEqual([]);
      await menu.$(`[data-command-id="${command}"]`).click();
      const input = $('[role="combobox"]');
      await input.waitForDisplayed({ timeout: 10000 });
      expect(await input.getValue()).toBe(query);
      await browser.keys(Key.Escape);
      await input.waitForExist({ reverse: true, timeout: 10000 });
    }
  });

  it("round_trips_source_mode_with_display_title_and_path_identity", async () => {
    const original = noteOnDisk(VISUAL_NOTE_NAME);
    await openNoteFromTree(VISUAL_NOTE_NAME);
    await $(".skr-properties-toggle").waitForExist({ timeout: 10000 });
    expect(await $("[data-testid=note-title]").getText()).toBe(
      "A room for reading",
    );
    // The compact header of section 4.15 carries the caps label and the
    // property count; note identity lives in the title region and tree.
    expect(await $(".skr-properties-count").getText()).toBe("4");
    expect(await $("[data-testid=source-mode-chip]").isExisting()).toBe(false);

    await browser.keys([modifierKey, "e"]);
    const chip = $("[data-testid=source-mode-chip]");
    await chip.waitForDisplayed({ timeout: 10000 });
    expect(await chip.getText()).toBe("Source");
    expect(await $(".skr-properties").isExisting()).toBe(false);
    await browser.waitUntil(
      async () => (await editorDocumentText()) === VISUAL_NOTE_CONTENT,
      {
        timeout: 10000,
        timeoutMsg: "source mode did not expose the exact note text",
      },
    );
    const sourcePresentation = await browser.execute(() => {
      const editor = document.querySelector<HTMLElement>(".editor");
      const content = document.querySelector<HTMLElement>(".cm-content");
      return {
        sourceClass: editor?.classList.contains("skr-source-mode") ?? false,
        fontFamily:
          content === null ? "" : getComputedStyle(content).fontFamily,
        monoToken: getComputedStyle(document.documentElement)
          .getPropertyValue("--skr-font-mono")
          .trim(),
        taskWidgets: document.querySelectorAll(".cm-skr-task-checkbox").length,
      };
    });
    expect(sourcePresentation.sourceClass).toBe(true);
    expect(sourcePresentation.fontFamily).toContain(
      sourcePresentation.monoToken.split(",")[0]?.replaceAll('"', "") ?? "",
    );
    expect(sourcePresentation.taskWidgets).toBe(0);

    await $('button[aria-label="More actions"]').click();
    const menu = $('[data-testid="anchored-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    expect(
      await menu
        .$('[data-command-id="editor.toggle-source-mode"]')
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await browser.keys(Key.Escape);
    await menu.waitForExist({ reverse: true, timeout: 10000 });

    await browser.keys([modifierKey, "e"]);
    await chip.waitForExist({ reverse: true, timeout: 10000 });
    await $(".skr-properties").waitForExist({ timeout: 10000 });
    await $(".cm-skr-table-row").waitForExist({ timeout: 10000 });
    expect(noteOnDisk(VISUAL_NOTE_NAME)).toBe(original);
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
        const pane = document.querySelector<HTMLElement>(
          "main > .skr-workspace > section",
        );
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
      expect(shell?.visibleRegions[0]?.className).toContain(
        "skr-header-leading",
      );
      expect(shell?.visibleRegions[0]?.width).toBe(44);
      expect(shell?.visibleRegions[0]?.height).toBe(44);
      expect(shell?.visibleRegions[1]?.className).toContain(
        "skr-note-title-region",
      );
      expect(shell?.visibleRegions[2]?.className).toContain(
        "skr-header-trailing",
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
      expect(await $$(".skr-note-title-region h2")).toHaveLength(0);
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
      expect(await title.getText()).toBe("Phone heading");
      expect(await $$(".skr-note-title-region h2")).toHaveLength(1);
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
        { command: "application.zoom-in", label: "Zoom in" },
        { command: "application.zoom-out", label: "Zoom out" },
        { command: "application.zoom-reset", label: "Reset zoom" },
        { command: "link.copy-note", label: "Copy link to note" },
        { command: "link.copy-permalink", label: "Copy permalink" },
        { command: "find.open", label: "Find in note" },
        { command: "editor.toggle-source-mode", label: "Toggle source mode" },
        { command: "navigation.back", label: "Navigate back" },
        { command: "navigation.forward", label: "Navigate forward" },
        { command: "tree.note.create", label: "New note" },
        { command: "tree.folder.create", label: "New folder" },
        { command: "tree.entry.rename", label: "Rename" },
        { command: "tree.entry.delete", label: "Delete" },
        { command: "tree.entry.move", label: "Move" },
        { command: "tree.note.open-in-new-tab", label: "Open in new tab" },
        { command: "tree.note.copy-link", label: "Copy link" },
        { command: "tree.entry.reveal", label: "Reveal in file manager" },
        { command: "panel.sidebar.toggle", label: "Toggle sidebar" },
        { command: "panel.outline.toggle", label: "Toggle outline" },
        { command: "tab.new", label: "New tab" },
        { command: "tab.close", label: "Close tab" },
        { command: "tab.reopen-closed", label: "Reopen closed tab" },
        { command: "tab.next", label: "Next tab" },
        { command: "tab.previous", label: "Previous tab" },
        { command: "tab.activate-1", label: "Activate tab 1" },
        { command: "tab.activate-2", label: "Activate tab 2" },
        { command: "tab.activate-3", label: "Activate tab 3" },
        { command: "tab.activate-4", label: "Activate tab 4" },
        { command: "tab.activate-5", label: "Activate tab 5" },
        { command: "tab.activate-6", label: "Activate tab 6" },
        { command: "tab.activate-7", label: "Activate tab 7" },
        { command: "tab.activate-8", label: "Activate tab 8" },
        { command: "tab.activate-9", label: "Activate tab 9" },
        { command: "vault.open", label: "Open vault" },
      ]);
      for (const target of await overflowSheet.$$("button:not(:disabled)")) {
        const size = await target.getSize();
        expect(Math.round(size.height)).toBeGreaterThanOrEqual(44);
      }

      await overflowSheet.$('[data-command-id="palette.open"]').click();
      const commandSurface = $('[data-testid="unified-command-surface"]');
      await commandSurface.waitForDisplayed({ timeout: 10000 });
      await waitForSurfaceEntrance(
        '[data-testid="unified-command-surface"] .command-surface-dialog',
      );
      const commandInput = commandSurface.$('[role="combobox"]');
      expect(await commandInput.getValue()).toBe(">");
      expect(await commandInput.getAttribute("data-search-mode")).toBe(
        "command",
      );
      const paletteRows = await browser.execute(() =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-testid="unified-command-surface"] [role="option"][data-command-id]',
          ),
        ].map((option) => ({
          commandId: option.dataset.commandId ?? "",
          height: option.getBoundingClientRect().height,
        })),
      );
      const paletteCommandIds = paletteRows.map((row) => row.commandId);
      expect(paletteCommandIds.length).toBeGreaterThan(50);
      expect(new Set(paletteCommandIds).size).toBe(paletteCommandIds.length);
      for (const row of paletteRows) {
        expect(row.height).toBeGreaterThanOrEqual(44);
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
          "editor.toggle-source-mode",
          "task.set-status",
          "vault.open",
        ]),
      );
      expect(paletteCommandIds).not.toEqual(
        expect.arrayContaining([
          "pane.split-right",
          "pane.focus-left",
          "pane.focus-right",
          "pane.move-tab",
        ]),
      );
      await browser.keys(Key.Escape);
      await commandSurface.waitForExist({ reverse: true, timeout: 10000 });

      await filesButton.click();
      const filesSheet = $('[data-testid="overlay-sheet"]');
      await filesSheet.waitForDisplayed({ timeout: 10000 });
      await filesSheet
        .$(`[role="treeitem"][data-path="${PHONE_PLAIN_NOTE_NAME}"]`)
        .click();
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

  it("routes_phone_overflow_search_to_the_unified_surface", async () => {
    try {
      await setViewportSize(390, 844);
      const overflowButton = $('button[aria-label="More actions"]');
      await overflowButton.waitForDisplayed({ timeout: 10000 });
      await overflowButton.click();
      const overflowSheet = $('[data-testid="overlay-sheet"]');
      await overflowSheet.waitForDisplayed({ timeout: 10000 });
      await overflowSheet.$('[data-command-id="vault-search.open"]').click();
      const commandSurface = $('[data-testid="unified-command-surface"]');
      await commandSurface.waitForDisplayed({ timeout: 10000 });
      const input = commandSurface.$('[role="combobox"]');
      expect(await input.getValue()).toBe("?");
      expect(await input.getAttribute("data-search-mode")).toBe("text");
      await browser.keys(Key.Escape);
      await commandSurface.waitForExist({ reverse: true, timeout: 10000 });
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
      await waitForSurfaceEntrance(
        '[data-testid="unified-command-surface"] .command-surface-dialog',
      );
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
      await typeTagCompletionQuery(packagedTagCompletionHarness, "final");
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

  it("keeps_the_formatting_toolbar_clear_of_the_prose", async () => {
    await openNoteFromTree(VISUAL_NOTE_NAME);
    await $(".cm-skr-rich-callout").waitForExist({ timeout: 15000 });

    try {
      await setViewportSize(1280, 800);
      await selectEditorText("Patient typography");
      await $(".cm-skr-selection-toolbar").waitForExist({ timeout: 10000 });
      const wide = await browser.execute(() => {
        const bar = document.querySelector<HTMLElement>(
          ".cm-skr-selection-toolbar",
        );
        const scroller = document.querySelector<HTMLElement>(".cm-scroller");
        if (bar === null || scroller === null) {
          throw new Error("toolbar or scroller missing");
        }
        const box = (bar.closest(".cm-tooltip") ?? bar).getBoundingClientRect();
        let left = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        for (const line of document.querySelectorAll<HTMLElement>(
          ".cm-content > .cm-line:not(.cm-skr-rich-callout)",
        )) {
          const lineBox = line.getBoundingClientRect();
          const style = window.getComputedStyle(line);
          left = Math.min(
            left,
            lineBox.left + Number.parseFloat(style.paddingLeft),
          );
          right = Math.max(
            right,
            lineBox.right - Number.parseFloat(style.paddingRight),
          );
        }
        // How wide a window has to be for the margin to hold the toolbar
        // depends on the pane, the sidebar and the prose font, so the
        // expectation is read from the room this window actually has rather
        // than assumed from its width.
        const scrollerBox = scroller.getBoundingClientRect();
        const room = Math.max(
          scrollerBox.right - right,
          left - scrollerBox.left,
        );
        return {
          placement: bar.dataset.placement,
          marginHoldsTheToolbar: room >= box.width,
          clearOfColumn: box.left >= right || box.right <= left,
        };
      });
      // Given the room, the toolbar takes the margin; it only covers prose
      // when there is nowhere else for it to go.
      if (wide.marginHoldsTheToolbar) {
        expect(wide.placement).toBe("margin");
        expect(wide.clearOfColumn).toBe(true);
      } else {
        expect(wide.placement).toBe("over-text");
      }

      // A window with no margin to spare falls back over the text, and buys
      // clearance from the line it covers rather than sitting flush on it.
      await setViewportSize(560, 760);
      await clearEditorSelection();
      await selectEditorText("Patient typography");
      await $(".cm-skr-selection-toolbar").waitForExist({ timeout: 10000 });
      const narrow = await browser.execute(() => {
        const bar = document.querySelector<HTMLElement>(
          ".cm-skr-selection-toolbar",
        );
        if (bar === null) throw new Error("toolbar missing");
        const box = (bar.closest(".cm-tooltip") ?? bar).getBoundingClientRect();
        const anchor = [
          ...document.querySelectorAll<HTMLElement>(".cm-content > .cm-line"),
        ].find((line) =>
          (line.textContent ?? "").includes("Patient typography"),
        );
        if (anchor === undefined) throw new Error("anchor line missing");
        return {
          placement: bar.dataset.placement,
          gap: anchor.getBoundingClientRect().top - box.bottom,
        };
      });
      expect(narrow.placement).toBe("over-text");
      expect(narrow.gap).toBeGreaterThan(0);
    } finally {
      await restoreDesktopViewport();
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

  it("edits_rendered_table_cells_with_one_caret_and_exact_source_bytes", async () => {
    await openNoteFromTree(TABLE_EDITING_NOTE_NAME);
    await browser.waitUntil(
      async () => (await $$(".cm-skr-table-grid")).length === 2,
      { timeout: 15000, timeoutMsg: "table editing fixture did not render" },
    );

    const original = TABLE_EDITING_NOTE_CONTENT;
    try {
      const grids = await $$(".cm-skr-table-grid");
      expect(await grids[0]?.getAttribute("role")).toBe("grid");
      expect(await grids[0]?.getAttribute("aria-rowcount")).toBe("3");
      expect(await grids[0]?.getAttribute("aria-colcount")).toBe("2");
      expect(await grids[1]?.getAttribute("aria-rowcount")).toBe("31");
      expect(await grids[1]?.getAttribute("aria-colcount")).toBe("2");
      const firstRows = await grids[0]?.$$(":scope > [role='row']");
      expect(firstRows).toHaveLength(3);
      for (const [index, row] of (firstRows ?? []).entries()) {
        expect(await row.getAttribute("aria-rowindex")).toBe(String(index + 1));
      }
      const headerCells = await firstRows?.[0]?.$$("[role='columnheader']");
      expect(headerCells).toHaveLength(2);
      const bodyCells = await grids[0]?.$$("[role='gridcell']");
      expect(bodyCells).toHaveLength(4);
      for (const [index, cell] of (headerCells ?? []).entries()) {
        expect(await cell.getAttribute("aria-colindex")).toBe(
          String(index + 1),
        );
        expect(await cell.getAttribute("aria-selected")).toBe("false");
      }
      for (const cell of bodyCells ?? []) {
        expect(await cell.getAttribute("aria-selected")).toBe("false");
      }
      const firstBodyCell = grids[0]?.$(
        '.cm-skr-table-cell[data-row="1"][data-column="0"]',
      );
      expect(await firstBodyCell?.getAttribute("role")).toBe("gridcell");
      const clickPoint = await browser.execute(() => {
        const content = document.querySelector<HTMLElement>(
          '.cm-skr-table-cell[data-row="1"][data-column="0"] .cm-content',
        );
        const walker = document.createTreeWalker(
          content ?? document.body,
          NodeFilter.SHOW_TEXT,
        );
        const text = walker.nextNode();
        if (
          content === null ||
          text === null ||
          (text.textContent ?? "") === ""
        ) {
          throw new Error("editable table cell text is missing");
        }
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        const rect = range.getBoundingClientRect();
        return {
          x: Math.floor(rect.left + 1),
          y: Math.round(rect.top + rect.height / 2),
        };
      });
      await browser.performActions([
        {
          type: "pointer",
          id: "table-cell-pointer",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              x: clickPoint.x,
              y: clickPoint.y,
            },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();
      await browser.waitUntil(
        async () =>
          (await firstBodyCell?.getAttribute("data-editing")) === "true",
        { timeout: 10000, timeoutMsg: "table cell did not acquire its caret" },
      );
      expect(
        await browser.execute(
          () =>
            document.activeElement?.classList.contains("cm-content") ?? false,
        ),
      ).toBe(true);
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const selection = getSelection();
            const active = document.activeElement;
            return (
              active?.classList.contains("cm-content") === true &&
              selection?.isCollapsed === true &&
              selection.anchorNode !== null &&
              active.contains(selection.anchorNode)
            );
          }),
        { timeout: 10000 },
      );
      const insertFocusedText = async (text: string) => {
        await $('.cm-skr-table-cell[data-editing="true"] .cm-content').addValue(
          text,
        );
      };
      await insertFocusedText("Z");
      const endPoint = await browser.execute(() => {
        const cell = document.querySelector<HTMLElement>(
          '.cm-skr-table-cell[data-editing="true"]',
        );
        if (cell === null) {
          throw new Error("editable table cell is missing");
        }
        const rect = cell.getBoundingClientRect();
        return {
          x: Math.floor(rect.right - 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      });
      await browser.performActions([
        {
          type: "pointer",
          id: "table-cell-end-pointer",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              x: endPoint.x,
              y: endPoint.y,
            },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();

      const initialTemplate = await browser.execute(
        () =>
          getComputedStyle(
            document.querySelector<HTMLElement>(
              ".cm-skr-table-row",
            ) as HTMLElement,
          ).gridTemplateColumns,
      );
      const templates: string[][] = [];
      for (const character of [..."longer|"]) {
        await insertFocusedText(character);
        await viewportAfterPaint();
        templates.push(
          await browser.execute(() => {
            const grid = document.querySelector(".cm-skr-table-grid");
            return [
              ...(grid?.querySelectorAll<HTMLElement>(".cm-skr-table-row") ??
                []),
            ].map((row) => getComputedStyle(row).gridTemplateColumns);
          }),
        );
      }

      const edited = original.replace("| café   |", "| Zcafélonger\\|   |");
      await browser.keys([modifierKey, "p"]);
      const sourceSurface = $('[data-testid="unified-command-surface"]');
      await sourceSurface.waitForDisplayed({ timeout: 10000 });
      await sourceSurface.$('[role="combobox"]').addValue("table edit source");
      await browser.keys(Key.Enter);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 1,
        { timeout: 10000 },
      );
      expect(await editorText()).toContain("Zcafélonger\\|");
      await browser.keys(Key.Escape);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 2,
        { timeout: 10000 },
      );
      await browser.keys([modifierKey, "s"]);
      await waitForDisk(TABLE_EDITING_NOTE_NAME, edited);
      for (const sample of templates) {
        expect(new Set(sample).size).toBe(1);
      }
      expect(
        templates.slice(0, 3).every((sample) => sample[0] === initialTemplate),
      ).toBe(true);
      for (let index = 3; index < templates.length; index += 1) {
        expect(templates[index]?.[0]).not.toBe(templates[index - 1]?.[0]);
      }
      const oneCaret = await browser.execute(() => {
        const parent = document.querySelector<HTMLElement>(
          '[data-table-cell-active="true"]',
        );
        const cell = document.querySelector<HTMLElement>(
          '.cm-skr-table-cell[data-editing="true"]',
        );
        return {
          parentParked:
            parent?.getAttribute("data-table-cell-active") === "true",
          editing: cell?.dataset.editing ?? null,
          selected: cell?.getAttribute("aria-selected") ?? null,
          hostCaretHidden:
            parent === null ||
            [
              ...parent.querySelectorAll<HTMLElement>(
                ":scope > .cm-scroller > .cm-cursorLayer .cm-cursor",
              ),
            ].every((caret) => getComputedStyle(caret).display === "none"),
          tabStops: [
            ...document.querySelectorAll<HTMLElement>(
              '.cm-skr-table-grid [tabindex="0"]',
            ),
          ].filter((element) => element.tabIndex === 0).length,
        };
      });
      expect(oneCaret).toEqual({
        parentParked: true,
        editing: "true",
        selected: "true",
        hostCaretHidden: true,
        tabStops: 1,
      });

      const travelEdge = await browser.execute(() => {
        const cell = document.querySelector<HTMLElement>(
          '.cm-skr-table-cell[data-editing="true"]',
        );
        if (cell === null) {
          throw new Error("editable table cell is missing");
        }
        const rect = cell.getBoundingClientRect();
        return {
          x: Math.floor(rect.right - 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      });
      await browser.performActions([
        {
          type: "pointer",
          id: "table-travel-edge-pointer",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              x: travelEdge.x,
              y: travelEdge.y,
            },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();
      await pressFocusedKey("ArrowRight");
      expect(noteOnDisk(TABLE_EDITING_NOTE_NAME)).toBe(edited);
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-column",
        ),
      ).toBe("1");
      await pressFocusedKey("Tab");
      expect(noteOnDisk(TABLE_EDITING_NOTE_NAME)).toBe(edited);
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-row",
        ),
      ).toBe("2");
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-column",
        ),
      ).toBe("0");
      await pressFocusedKey("Tab", true);
      expect(noteOnDisk(TABLE_EDITING_NOTE_NAME)).toBe(edited);
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-row",
        ),
      ).toBe("1");
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-column",
        ),
      ).toBe("1");

      await browser.keys([modifierKey, "p"]);
      const commandSurface = $('[data-testid="unified-command-surface"]');
      await commandSurface.waitForDisplayed({ timeout: 10000 });
      const commandInput = commandSurface.$('[role="combobox"]');
      await commandInput.addValue("table edit source");
      await browser.keys(Key.Enter);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 1,
        { timeout: 10000 },
      );
      expect(await editorText()).toContain("| :--- | ---: |");
      await browser.keys(Key.Escape);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 2,
        { timeout: 10000 },
      );
      expect(await $(".cm-skr-table-grid").getAttribute("role")).toBe("grid");
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-row",
        ),
      ).toBe("1");
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-column",
        ),
      ).toBe("1");

      await browser.keys(Key.Escape);
      await browser.keys([modifierKey, "e"]);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 0,
        { timeout: 10000 },
      );
      expect(await editorText()).toContain("| :--- | ---: |");
      expect(await editorText()).toContain("| --- | --- |");
      await browser.keys([modifierKey, "e"]);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 2,
        { timeout: 10000 },
      );
      expect(await editorText()).not.toContain("| :--- | ---: |");
      await placeCursorAtLineEnd("Large table follows.");
      await pressFocusedKey("ArrowDown");
      expect(noteOnDisk(TABLE_EDITING_NOTE_NAME)).toBe(edited);
      expect(await $$('.cm-skr-table-cell[data-editing="true"]')).toHaveLength(
        0,
      );
      await pressFocusedKey("ArrowDown");
      expect(noteOnDisk(TABLE_EDITING_NOTE_NAME)).toBe(edited);
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-row",
        ),
      ).toBe("0");
      for (let row = 1; row <= 30; row += 1) {
        await pressFocusedKey("ArrowDown");
        expect(
          await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
            "data-row",
          ),
        ).toBe(String(row));
      }
      await pressFocusedKey("ArrowDown");
      expect(noteOnDisk(TABLE_EDITING_NOTE_NAME)).toBe(edited);
      expect(await $$('.cm-skr-table-cell[data-editing="true"]')).toHaveLength(
        0,
      );
      await pressFocusedKey("ArrowUp");
      expect(noteOnDisk(TABLE_EDITING_NOTE_NAME)).toBe(edited);
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-row",
        ),
      ).toBe("30");
      await browser.keys(Key.Escape);
      expect(await $$(".cm-skr-table-grid")).toHaveLength(2);
      expect(await editorText()).not.toContain("| --- | --- |");

      const renderedTables = await $$(".cm-skr-table-grid");
      await renderedTables[0]
        ?.$('.cm-skr-table-cell[data-row="2"][data-column="1"]')
        .click();
      await pressFocusedKey("Tab");
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-row",
        ),
      ).toBe("3");
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-column",
        ),
      ).toBe("0");
      const tabGrown = edited.replace("| Ada | 10 |", "| Ada | 10 |\n| | |");
      await browser.keys([modifierKey, "s"]);
      await waitForDisk(TABLE_EDITING_NOTE_NAME, tabGrown);

      await pressFocusedKey("Enter");
      expect(
        await $('.cm-skr-table-cell[data-editing="true"]').getAttribute(
          "data-row",
        ),
      ).toBe("4");
      const enterGrown = tabGrown.replace(
        "| Ada | 10 |\n| | |",
        "| Ada | 10 |\n| | |\n| | |",
      );
      await browser.keys([modifierKey, "s"]);
      await waitForDisk(TABLE_EDITING_NOTE_NAME, enterGrown);
    } finally {
      await openNoteFromTree(VISUAL_NOTE_NAME);
      writeFileSync(
        path.join(SCRATCH_VAULT_PATH, TABLE_EDITING_NOTE_NAME),
        original,
      );
      await waitForDisk(TABLE_EDITING_NOTE_NAME, original);
      await dismissBannersForPath(TABLE_EDITING_NOTE_NAME);
    }
  });

  it("runs_rendered_table_structure_commands_by_keyboard_and_pointer", async () => {
    const original = TABLE_EDITING_NOTE_CONTENT;
    const firstTable = [
      "| Name  | Score |",
      "| :--- | ---: |",
      "| café   | keep  |",
      "| Ada | 10 |",
    ].join("\n");
    const tableRect = (cell = false) =>
      browser.execute((selectCell: boolean) => {
        const element = document.querySelector<HTMLElement>(
          selectCell
            ? '.cm-skr-table-grid .cm-skr-table-cell[data-row="1"][data-column="0"]'
            : ".cm-skr-table-grid",
        );
        if (element === null) {
          throw new Error("editable table surface is missing");
        }
        const rect = element.getBoundingClientRect();
        const scroller = element.closest<HTMLElement>(".cm-scroller");
        return {
          x: rect.x,
          y: rect.y,
          documentX: rect.x + window.scrollX + (scroller?.scrollLeft ?? 0),
          documentY: rect.y + window.scrollY + (scroller?.scrollTop ?? 0),
          width: rect.width,
          height: rect.height,
        };
      }, cell);
    const resetAndOpen = async () => {
      await openNoteFromTree(VISUAL_NOTE_NAME);
      writeFileSync(
        path.join(SCRATCH_VAULT_PATH, TABLE_EDITING_NOTE_NAME),
        original,
      );
      await waitForDisk(TABLE_EDITING_NOTE_NAME, original);
      await dismissBannersForPath(TABLE_EDITING_NOTE_NAME);
      await openNoteFromTree(TABLE_EDITING_NOTE_NAME);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 2,
        { timeout: 15000 },
      );
    };
    const focusBodyCell = async () => {
      const tables = await $$(".cm-skr-table-grid");
      await tables[0]
        ?.$('.cm-skr-table-cell[data-row="1"][data-column="0"] .cm-content')
        .click();
      await $('.cm-skr-table-cell[data-editing="true"]').waitForExist({
        timeout: 10000,
      });
    };
    // A surface is displayed as soon as it is rendered, which is while its
    // entrance is still travelling, so the row's position when WebDriver
    // resolves it is not its position when the click is dispatched. The
    // fact to wait on is the entrance having settled, not more time.
    const runCommand = async (query: string, id: string) => {
      await browser.keys([modifierKey, "p"]);
      const surface = $('[data-testid="unified-command-surface"]');
      await surface.waitForDisplayed({ timeout: 10000 });
      await waitForMotionSurfaceEntered(".command-surface-dialog");
      await surface.$('[role="combobox"]').addValue(query);
      const command = surface.$(`[role="option"][data-command-id="${id}"]`);
      await command.waitForDisplayed({ timeout: 10000 });
      await command.click();
      await surface.waitForExist({ reverse: true, timeout: 10000 });
    };
    const runPointerCommand = async (id: string) => {
      await $('button[aria-label="More actions"]').click();
      const menu = $('nav[aria-label="More actions"]');
      await menu.waitForDisplayed({ timeout: 10000 });
      await waitForMotionSurfaceEntered('[data-testid="anchored-menu"]');
      const command = menu.$(`button[data-command-id="${id}"]`);
      await command.waitForDisplayed({ timeout: 10000 });
      await command.click();
      await menu.waitForExist({ reverse: true, timeout: 10000 });
    };
    const cases = [
      {
        id: "table.row.insert-above",
        query: "table insert row above",
        shape: { rows: 4, columns: 2 },
        table: [
          "| Name  | Score |",
          "| :--- | ---: |",
          "| | |",
          "| café   | keep  |",
          "| Ada | 10 |",
        ].join("\n"),
      },
      {
        id: "table.row.insert-below",
        query: "table insert row below",
        shape: { rows: 4, columns: 2 },
        table: [
          "| Name  | Score |",
          "| :--- | ---: |",
          "| café   | keep  |",
          "| | |",
          "| Ada | 10 |",
        ].join("\n"),
      },
      {
        id: "table.column.insert-before",
        query: "table insert column left",
        shape: { rows: 3, columns: 3 },
        table: [
          "| | Name  | Score |",
          "| --- | :--- | ---: |",
          "| | café   | keep  |",
          "| | Ada | 10 |",
        ].join("\n"),
      },
      {
        id: "table.column.insert-after",
        query: "table insert column right",
        shape: { rows: 3, columns: 3 },
        table: [
          "| Name  | | Score |",
          "| :--- | --- | ---: |",
          "| café   | | keep  |",
          "| Ada | | 10 |",
        ].join("\n"),
      },
      {
        id: "table.row.delete",
        query: "table delete row",
        shape: { rows: 2, columns: 2 },
        table: ["| Name  | Score |", "| :--- | ---: |", "| Ada | 10 |"].join(
          "\n",
        ),
      },
      {
        id: "table.column.delete",
        query: "table delete column",
        shape: { rows: 3, columns: 1 },
        table: ["| Score |", "| ---: |", "| keep  |", "| 10 |"].join("\n"),
      },
    ] as const;

    try {
      // Two facts, in order: the command reached the note, read from the
      // rendered table's own shape, and the note reached the disk. They are
      // asserted separately because they fail for unrelated reasons and are
      // indistinguishable from the file alone — a command that never ran and
      // a save that never landed both leave the file exactly as it was.
      const waitForFirstGridShape = async (
        shape: { rows: number; columns: number },
        message: string,
      ) => {
        const readShape = async () => {
          const grid = (await $$(".cm-skr-table-grid"))[0];
          return grid === undefined
            ? "no rendered table"
            : `${await grid.getAttribute("aria-rowcount")}x${await grid.getAttribute("aria-colcount")}`;
        };
        const wanted = `${shape.rows}x${shape.columns}`;
        try {
          await browser.waitUntil(async () => (await readShape()) === wanted, {
            timeout: 10000,
          });
        } catch {
          throw new Error(
            `${message}; the rendered table is ${await readShape()}, expected ${wanted}`,
          );
        }
      };

      for (const entry of cases) {
        await resetAndOpen();
        await focusBodyCell();
        await runCommand(entry.query, entry.id);
        await waitForFirstGridShape(
          entry.shape,
          `${entry.id} from the command palette did not change the note`,
        );
        const expected = original.replace(firstTable, entry.table);
        await browser.keys([modifierKey, "s"]);
        await waitForDisk(TABLE_EDITING_NOTE_NAME, expected);
        expect(await $$(".cm-skr-table-grid")).toHaveLength(2);
        expect(await editorText()).not.toContain("| :--- | ---: |");
      }

      for (const entry of cases) {
        await resetAndOpen();
        await focusBodyCell();
        await runPointerCommand(entry.id);
        await waitForFirstGridShape(
          entry.shape,
          `${entry.id} from the overflow menu did not change the note`,
        );
        const expected = original.replace(firstTable, entry.table);
        await browser.keys([modifierKey, "s"]);
        await waitForDisk(TABLE_EDITING_NOTE_NAME, expected);
        expect(await $$(".cm-skr-table-grid")).toHaveLength(2);
        expect(await editorText()).not.toContain("| :--- | ---: |");
      }

      await resetAndOpen();
      await focusBodyCell();
      await runPointerCommand("table.edit-source");
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 1,
        { timeout: 10000 },
      );
      expect(await editorText()).toContain("| :--- | ---: |");
      await browser.keys(Key.Escape);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 2,
        { timeout: 10000 },
      );

      await resetAndOpen();
      const before = await tableRect();
      const rowStrip = $('[aria-label="Append table row"]');
      await rowStrip.moveTo();
      await viewportAfterPaint();
      const afterRowHover = await tableRect();
      for (const key of [
        "documentX",
        "documentY",
        "width",
        "height",
      ] as const) {
        expect(Math.abs(afterRowHover[key] - before[key])).toBeLessThanOrEqual(
          1,
        );
      }
      await rowStrip.click();
      const rowExpected = original.replace(firstTable, `${firstTable}\n| | |`);
      await browser.keys([modifierKey, "s"]);
      await waitForDisk(TABLE_EDITING_NOTE_NAME, rowExpected);

      await resetAndOpen();
      const columnBefore = await tableRect();
      const columnStrip = $('[aria-label="Append table column"]');
      await columnStrip.moveTo();
      await viewportAfterPaint();
      const afterColumnHover = await tableRect();
      for (const key of [
        "documentX",
        "documentY",
        "width",
        "height",
      ] as const) {
        expect(
          Math.abs(afterColumnHover[key] - columnBefore[key]),
        ).toBeLessThanOrEqual(1);
      }
      await columnStrip.click();
      const columnExpected = original.replace(
        firstTable,
        [
          "| Name  | Score | |",
          "| :--- | ---: | --- |",
          "| café   | keep  | |",
          "| Ada | 10 | |",
        ].join("\n"),
      );
      await browser.keys([modifierKey, "s"]);
      await waitForDisk(TABLE_EDITING_NOTE_NAME, columnExpected);

      await resetAndOpen();
      await focusBodyCell();
      const selectionEdge = await browser.execute(() => {
        const cell = document.querySelector<HTMLElement>(
          '.cm-skr-table-cell[data-editing="true"]',
        );
        if (cell === null) {
          throw new Error("editable table cell is missing");
        }
        const rect = cell.getBoundingClientRect();
        return {
          x: Math.floor(rect.right - 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      });
      await browser.performActions([
        {
          type: "pointer",
          id: "table-selection-edge-pointer",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              x: selectionEdge.x,
              y: selectionEdge.y,
            },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();
      await pressFocusedKey("End");
      expect(
        await browser.execute(() => {
          const content = document.querySelector<HTMLElement>(
            '.cm-skr-table-cell[data-editing="true"] .cm-content',
          );
          const selection = window.getSelection();
          const beforeCaret = document.createRange();
          if (
            content !== null &&
            selection?.focusNode !== null &&
            content.contains(selection?.focusNode ?? null)
          ) {
            beforeCaret.selectNodeContents(content);
            beforeCaret.setEnd(
              selection?.focusNode ?? content,
              selection?.focusOffset ?? 0,
            );
          }
          return {
            focused: content?.contains(document.activeElement) ?? false,
            atEnd:
              selection !== null &&
              content !== null &&
              selection.isCollapsed &&
              selection.focusNode !== null &&
              content.contains(selection.focusNode) &&
              beforeCaret.toString().length === content.textContent?.length,
          };
        }),
      ).toEqual({ focused: true, atEnd: true });
      await pressFocusedKey("ArrowRight", true);
      await $(".cm-skr-table-selected").waitForExist({ timeout: 10000 });
      expect(
        await browser.execute(() => {
          const copied = new Map<string, string>();
          const clipboardData = {
            clearData: Map.prototype.clear.bind(copied),
            getData: Map.prototype.get.bind(copied),
            setData: Map.prototype.set.bind(copied),
          };
          const event = new Event("copy", {
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(event, "clipboardData", {
            value: clipboardData,
          });
          document.activeElement?.dispatchEvent(event);
          return copied.get("text/plain") ?? null;
        }),
      ).toBe(firstTable);
      await browser.keys(Key.Backspace);
      const deletedExpected = original.replace(firstTable, "");
      await browser.keys([modifierKey, "s"]);
      await waitForDisk(TABLE_EDITING_NOTE_NAME, deletedExpected);
      await browser.waitUntil(
        async () => (await $$(".cm-skr-table-grid")).length === 1,
        {
          timeout: 10000,
          timeoutMsg: "deleted rendered table did not settle",
        },
      );

      await resetAndOpen();
      const dragCellRect = await tableRect(true);
      await $(
        '.cm-skr-table-grid .cm-skr-table-cell[data-row="1"][data-column="0"]',
      ).dragAndDrop(
        {
          x: -Math.round(dragCellRect.width / 2 + 8),
          y: -Math.round(dragCellRect.height / 2 + 8),
        },
        { duration: 240 },
      );
      await $(".cm-skr-table-selected").waitForExist({ timeout: 10000 });
      expect(await $$('.cm-skr-table-cell[data-editing="true"]')).toHaveLength(
        0,
      );
      expect(await $$(".cm-skr-table-grid")).toHaveLength(2);
      expect(await editorText()).not.toContain("| :--- | ---: |");
      expect(
        await browser.execute(() => {
          const copied = new Map<string, string>();
          const clipboardData = {
            clearData: Map.prototype.clear.bind(copied),
            getData: Map.prototype.get.bind(copied),
            setData: Map.prototype.set.bind(copied),
          };
          const event = new Event("copy", {
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(event, "clipboardData", {
            value: clipboardData,
          });
          document.activeElement?.dispatchEvent(event);
          return copied.get("text/plain") ?? null;
        }),
      ).toBe(firstTable);
      await browser.keys(Key.Delete);
      await browser.keys([modifierKey, "s"]);
      await waitForDisk(
        TABLE_EDITING_NOTE_NAME,
        original.replace(firstTable, ""),
      );
      expect(await $$(".cm-skr-table-grid")).toHaveLength(1);
    } finally {
      await openNoteFromTree(VISUAL_NOTE_NAME);
      writeFileSync(
        path.join(SCRATCH_VAULT_PATH, TABLE_EDITING_NOTE_NAME),
        original,
      );
      await waitForDisk(TABLE_EDITING_NOTE_NAME, original);
      await dismissBannersForPath(TABLE_EDITING_NOTE_NAME);
    }
  });

  it("keeps_major_narrow_surfaces_inside_the_viewport", async () => {
    await restoreDesktopViewport();
    const surfaces: Array<{
      surface: string;
      escapes: HorizontalEscape[];
    }> = [];

    try {
      await prepareTableGeometryNote();
      if (
        await $(
          '.skr-header-leading [data-command-id="panel.sidebar.toggle"]',
        ).isExisting()
      ) {
        await $(
          '.skr-header-leading [data-command-id="panel.sidebar.toggle"]',
        ).click();
      }
      const openSidebar = $(".skr-desktop-sidebar");
      await openSidebar.waitForDisplayed({ timeout: 10000 });
      surfaces.push({
        surface: "desktop sidebar open",
        escapes: await horizontalViewportEscapes(),
      });
      await openSidebar.$('[data-command-id="panel.sidebar.toggle"]').click();
      await openSidebar
        .$(".skr-sidebar-content")
        .waitForDisplayed({ reverse: true, timeout: 10000 });
      surfaces.push({
        surface: "desktop sidebar collapsed",
        escapes: await horizontalViewportEscapes(),
      });
      const collapsedSidebarToggle = $(
        '.skr-header-leading [data-command-id="panel.sidebar.toggle"]',
      );
      await collapsedSidebarToggle.waitForDisplayed({ timeout: 10000 });
      await collapsedSidebarToggle.click();
      await $(".skr-sidebar-content").waitForDisplayed({ timeout: 10000 });

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
      await sheet
        .$(`[role="treeitem"][data-path="${RENDERING_NOTE_NAME}"]`)
        .click();
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
      "desktop sidebar open",
      "desktop sidebar collapsed",
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
    expect(await propertiesToggle.getAttribute("aria-expanded")).toBe("true");

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

    await propertiesToggle.click();
    await browser.waitUntil(
      async () =>
        (await propertiesToggle.getAttribute("aria-expanded")) === "false",
      { timeout: 5000 },
    );

    await dismissBannersForPath();
    mkdirSync(screenshotDirectory, { recursive: true });
    const caretColors: string[] = [];
    for (const theme of ["light", "dark"] as const) {
      await clearEditorSelection();
      await applyVisualTheme(theme);
      // The editor draws its own caret, so the property a reader sees is the
      // rendered bar rather than the content element's `caret-color`, which
      // the drawn caret deliberately makes transparent.
      const caret = await browser.execute(() => {
        const cursor = document.querySelector<HTMLElement>(".cm-cursor");
        const style = cursor === null ? null : getComputedStyle(cursor);
        return {
          drawn: cursor !== null,
          displayed: style !== null && style.display !== "none",
          focused:
            document
              .querySelector(".cm-editor")
              ?.classList.contains("cm-focused") ?? false,
          width: style?.borderLeftWidth ?? "",
          color: style?.borderLeftColor ?? "",
          token: getComputedStyle(document.documentElement)
            .getPropertyValue("--skr-caret")
            .trim(),
        };
      });
      expect(caret.drawn).toBe(true);
      // A caret paints exactly while the editor holds focus, which is the
      // invariant worth pinning: this window does not always own focus.
      expect(caret.displayed).toBe(caret.focused);
      expect(caret.width).toBe("2px");
      expect(caret.color).not.toBe("");
      expect(caret.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(caret.token).not.toBe("");
      caretColors.push(caret.color);
      await dismissBannersForPath();
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
      // Wait out the measured transition itself (plus a small margin)
      // rather than a duration guessed to outlast it: a reduced-motion
      // environment can legitimately report a near-zero
      // transitionDuration, at which point this resolves immediately
      // instead of over- or under-shooting a hardcoded constant. A
      // `transitionend` listener was considered instead, but that same
      // reduced-motion case can suppress the transition (and its event)
      // entirely, which would hang the wait rather than skip it.
      await browser.pause(revealDuration + 50);
      await dismissBannersForPath();
      await browser.saveScreenshot(
        path.join(screenshotDirectory, `after-frontmatter-${theme}.png`),
      );

      expect(await $(".skr-raw-toggle").isExisting()).toBe(false);
      expect(noteOnDisk(VISUAL_NOTE_NAME)).toBe(originalBytes);
      await propertiesToggle.click();
      await browser.waitUntil(
        async () =>
          (await propertiesToggle.getAttribute("aria-expanded")) === "false",
        { timeout: 5000 },
      );

      await selectEditorText("Patient typography");
      await $(".cm-skr-selection-toolbar").waitForExist({ timeout: 5000 });
      await dismissBannersForPath();
      await browser.saveScreenshot(
        path.join(screenshotDirectory, `after-toolbar-${theme}.png`),
      );
    }

    // The caret is a themed token, not a fixed colour: the two palettes must
    // not resolve it to the same bar.
    expect(caretColors).toHaveLength(2);
    expect(caretColors[0]).not.toBe(caretColors[1]);

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

  it("edits_a_file_that_is_not_a_note_without_rewriting_its_other_bytes", async () => {
    await openNoteFromTree(CONFIG_FILE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("drafts/*.tmp"),
      { timeout: 15000 },
    );

    await placeCursorAtLineEnd("drafts/*.tmp");
    await $(".cm-content").addValue("!");
    await browser.keys([modifierKey, "s"]);

    // CRLF terminators survive, no final newline is invented, and only the
    // typed byte is added: the same guarantees a note gets, for a file the
    // note extensions do not cover.
    await waitForDisk(CONFIG_FILE_NAME, `${CONFIG_FILE_CONTENT}!`);
  });

  it("renders_an_image_file_at_its_natural_dimensions", async () => {
    const row = $(`[role="treeitem"][data-path="${IMAGE_FILE_NAME}"]`);
    await row.waitForExist({ timeout: 15000 });
    await row.click();
    try {
      await browser.waitUntil(
        async () => (await currentNotePath()) === IMAGE_FILE_NAME,
        { timeout: 3000 },
      );
    } catch {
      await browser.execute((path: string) => {
        (
          window as Window & {
            __SKRIBEUM_E2E_OPEN_PATH__?: (path: string) => void;
          }
        ).__SKRIBEUM_E2E_OPEN_PATH__?.(path);
      }, IMAGE_FILE_NAME);
      await browser.waitUntil(
        async () => (await currentNotePath()) === IMAGE_FILE_NAME,
        {
          timeout: 15000,
          timeoutMsg: `${IMAGE_FILE_NAME} did not become the active document`,
        },
      );
    }

    const frame = $('[data-testid="image-view-frame"]');
    await frame.waitForExist({ timeout: 15000 });

    // Measure the decoded image, not an attribute the viewer set: an
    // element that never loaded reports zero for both.
    const measured = await browser.waitUntil(
      async () => {
        const size = await browser.execute(() => {
          const element = document.querySelector<HTMLImageElement>(
            '[data-testid="image-view-frame"]',
          );
          return element === null
            ? null
            : {
                tag: element.tagName,
                complete: element.complete,
                naturalWidth: element.naturalWidth,
                naturalHeight: element.naturalHeight,
                scheme: element.currentSrc.split(":")[0],
              };
        });
        return size !== null && size.naturalWidth > 0 ? size : false;
      },
      {
        timeout: 15000,
        timeoutMsg: `${IMAGE_FILE_NAME} never decoded in the viewer`,
      },
    );

    expect(measured.tag).toBe("IMG");
    expect(measured.complete).toBe(true);
    expect(measured.naturalWidth).toBe(IMAGE_FILE_WIDTH);
    expect(measured.naturalHeight).toBe(IMAGE_FILE_HEIGHT);
    // Vault bytes reach the element as a blob, never as a file URL or as
    // markup the webview would parse as a document.
    expect(measured.scheme).toBe("blob");
  });

  it("restores_history_scroll_and_utf8_caret_without_editor_focus", async () => {
    await openNoteFromTree(NAVIGATION_SOURCE_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("Navigation source"),
      { timeout: 15000 },
    );
    const freshSourceState = await capturedHistoryState();
    expect(freshSourceState?.anchor).toBe(0);
    expect(freshSourceState?.head).toBe(0);
    expect(freshSourceState?.propertiesExpanded).toBe(true);
    expect(
      await browser.execute(
        () => document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop,
      ),
    ).toBe(0);

    const sourceProperties = $(".skr-properties-toggle");
    await sourceProperties.waitForExist({ timeout: 10000 });
    expect(await sourceProperties.getAttribute("aria-expanded")).toBe("true");
    await sourceProperties.click();
    await browser.waitUntil(
      async () =>
        (await sourceProperties.getAttribute("aria-expanded")) === "false",
      { timeout: 5000 },
    );

    await browser.execute(() =>
      document.querySelector<HTMLElement>(".cm-content")?.focus(),
    );
    const sourceMarker = "Café restoration marker";
    const expectedSourceCaret = Buffer.byteLength(
      NAVIGATION_SOURCE_NOTE_CONTENT.slice(
        0,
        NAVIGATION_SOURCE_NOTE_CONTENT.indexOf(sourceMarker) +
          Math.floor(sourceMarker.length / 2),
      ),
      "utf8",
    );
    await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      if (scroller === null) throw new Error("editor scroller missing");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await browser.waitUntil(
      async () => (await editorText()).includes(sourceMarker),
      { timeout: 5000, timeoutMsg: "source history marker was not rendered" },
    );
    await placeCursorInsideEditorText(sourceMarker);
    await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      if (scroller === null) throw new Error("editor scroller missing");
      scroller.scrollTop = Math.floor(scroller.scrollHeight * 0.6);
    });
    await viewportAfterPaint();
    const savedState = await capturedHistoryState();
    const sourceScrollTop = await browser.execute(
      () => document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop,
    );
    expect(savedState).not.toBeNull();
    expect(savedState?.anchor).toBe(expectedSourceCaret);
    expect(savedState?.head).toBe(expectedSourceCaret);
    expect(savedState?.scrollAnchor).toBeGreaterThan(0);
    expect(savedState?.scrollOffset).toBeGreaterThanOrEqual(0);
    expect(savedState?.propertiesExpanded).toBe(false);
    expect(sourceScrollTop).toBeGreaterThan(0);

    await browser.executeAsync((targetPath: string, done) => {
      const open = (
        window as Window & {
          __SKRIBEUM_E2E_OPEN_NOTE__?: (path: string) => Promise<void>;
        }
      ).__SKRIBEUM_E2E_OPEN_NOTE__;
      if (open === undefined) {
        done(new Error("history navigation seam missing"));
        return;
      }
      open(targetPath)
        .then(() => done())
        .catch(done);
    }, NAVIGATION_TARGET_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("Wikilink destination content"),
      { timeout: 15000 },
    );
    expect(await activeElementDescriptor()).not.toContain("cm-content");
    const freshState = await capturedHistoryState();
    expect(freshState).toEqual({
      anchor: 0,
      head: 0,
      scrollAnchor: 0,
      scrollOffset: 0,
      propertiesExpanded: true,
    });
    expect((await readingSurfaceFocusState()).editorFocused).toBe(false);

    const widthAtDefaultZoom = await browser.execute(() => window.innerWidth);
    await browser.keys([modifierKey, "+"]);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.innerWidth)) < widthAtDefaultZoom,
      { timeoutMsg: "history zoom setup did not change the webview width" },
    );

    await browser.execute(() =>
      document.querySelector<HTMLElement>(".cm-content")?.focus(),
    );
    const targetMarker = "Target café restoration marker";
    const expectedTargetCaret = Buffer.byteLength(
      NAVIGATION_TARGET_NOTE_CONTENT.slice(
        0,
        NAVIGATION_TARGET_NOTE_CONTENT.indexOf(targetMarker) +
          Math.floor(targetMarker.length / 2),
      ),
      "utf8",
    );
    await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      if (scroller === null) throw new Error("editor scroller missing");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await browser.waitUntil(
      async () => (await editorText()).includes(targetMarker),
      { timeout: 5000, timeoutMsg: "target history marker was not rendered" },
    );
    await placeCursorInsideEditorText(targetMarker);
    await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      if (scroller === null) throw new Error("editor scroller missing");
      scroller.scrollTop = Math.floor(scroller.scrollHeight * 0.6);
    });
    await viewportAfterPaint();
    const targetState = await capturedHistoryState();
    const targetScrollTop = await browser.execute(
      () => document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop,
    );
    expect(targetState?.anchor).toBe(expectedTargetCaret);
    expect(targetState?.head).toBe(expectedTargetCaret);
    expect(targetState?.scrollAnchor).toBeGreaterThan(0);
    expect(targetState?.scrollOffset).toBeGreaterThanOrEqual(0);
    expect(targetState?.propertiesExpanded).toBe(true);
    expect(targetScrollTop).toBeGreaterThan(0);

    const back = $('button[aria-label="Back"]');
    await back.waitForEnabled({ timeout: 15000 });
    await browser.execute(() => {
      type ArrivalFrame = {
        animationsEnabled: boolean;
        contentEditable: string | null;
        duration: string;
        panelExpanded: string | null;
        pointerEvents: string;
        reducedMotion: boolean;
        scrollTop: number;
        themeSwitching: boolean;
        visibility: string;
      };
      const target = window as Window & {
        __SKRIBEUM_E2E_ARRIVAL_FRAME__?: ArrivalFrame | null;
      };
      target.__SKRIBEUM_E2E_ARRIVAL_FRAME__ = null;
      const shell = document.querySelector<HTMLElement>(".skr-editor-shell");
      if (shell === null) throw new Error("editor shell missing");
      const observer = new MutationObserver(() => {
        if (
          shell.dataset.motionPreparing === undefined &&
          shell.dataset.motionEntered === "true"
        ) {
          observer.disconnect();
          requestAnimationFrame(() => {
            const editor = document.querySelector<HTMLElement>(".cm-editor");
            const content = document.querySelector<HTMLElement>(".cm-content");
            const scroller =
              document.querySelector<HTMLElement>(".cm-scroller");
            const panel = document.querySelector<HTMLElement>(
              ".skr-properties-toggle",
            );
            if (editor === null || content === null || scroller === null) {
              throw new Error("arrival frame incomplete");
            }
            const shellStyle = getComputedStyle(shell);
            target.__SKRIBEUM_E2E_ARRIVAL_FRAME__ = {
              animationsEnabled:
                document.documentElement.dataset.animations !== "false",
              contentEditable: content.getAttribute("contenteditable"),
              duration: shellStyle.transitionDuration,
              panelExpanded: panel?.getAttribute("aria-expanded") ?? null,
              pointerEvents: shellStyle.pointerEvents,
              reducedMotion: matchMedia("(prefers-reduced-motion: reduce)")
                .matches,
              scrollTop: scroller.scrollTop,
              themeSwitching:
                document.documentElement.dataset.themeSwitching === "true",
              visibility: getComputedStyle(editor).visibility,
            };
          });
        }
      });
      observer.observe(shell, { attributes: true });
    });
    await back.click();
    if (savedState === null) throw new Error("source history state missing");
    try {
      await waitForRestoredHistoryState(
        savedState,
        "history view state was not restored",
      );
    } catch (error) {
      await browser.keys([modifierKey, "0"]);
      throw error;
    }
    const restoredSourceScrollTopAtLargerZoom = await browser.execute(
      () => document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop,
    );
    expect(restoredSourceScrollTopAtLargerZoom).not.toBe(sourceScrollTop);
    await browser.keys([modifierKey, "0"]);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.innerWidth)) === widthAtDefaultZoom,
      { timeoutMsg: "history test did not reset webview zoom" },
    );
    expect(await readingSurfaceFocusState()).toEqual({
      readingSurface: true,
      editorFocused: false,
    });
    expect(
      await $(".skr-properties-toggle").getAttribute("aria-expanded"),
    ).toBe("false");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (
              window as Window & {
                __SKRIBEUM_E2E_ARRIVAL_FRAME__?: unknown;
              }
            ).__SKRIBEUM_E2E_ARRIVAL_FRAME__ != null,
        ),
      { timeout: 5000, timeoutMsg: "arrival frame was not observed" },
    );
    const arrivalFrame = await browser.execute(
      () =>
        (
          window as Window & {
            __SKRIBEUM_E2E_ARRIVAL_FRAME__?: {
              animationsEnabled: boolean;
              contentEditable: string | null;
              duration: string;
              panelExpanded: string | null;
              pointerEvents: string;
              reducedMotion: boolean;
              scrollTop: number;
              themeSwitching: boolean;
              visibility: string;
            };
          }
        ).__SKRIBEUM_E2E_ARRIVAL_FRAME__,
    );
    expect(arrivalFrame).toMatchObject({
      contentEditable: "true",
      panelExpanded: "false",
      pointerEvents: "auto",
      visibility: "visible",
    });
    expect(arrivalFrame?.duration).toBe(
      arrivalFrame?.reducedMotion === true ||
        arrivalFrame?.animationsEnabled === false ||
        arrivalFrame?.themeSwitching === true
        ? "0s"
        : "0.12s",
    );
    expect(arrivalFrame?.scrollTop).toBeGreaterThan(0);

    const forward = $('button[aria-label="Forward"]');
    await forward.waitForEnabled({ timeout: 15000 });
    await forward.click();
    if (targetState === null) throw new Error("target history state missing");
    await waitForRestoredHistoryState(
      targetState,
      "forward history view state was not restored",
    );
    expect(await readingSurfaceFocusState()).toEqual({
      readingSurface: true,
      editorFocused: false,
    });
    expect(
      await browser.execute(
        () => document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop,
      ),
    ).not.toBe(targetScrollTop);
  });

  it("opens_vault_search_from_a_tag", async () => {
    await openNoteFromTree(NAVIGATION_SOURCE_NOTE_NAME);
    expect(await currentNotePath()).toBe(NAVIGATION_SOURCE_NOTE_NAME);
    const movedToStart = await browser.execute(() => {
      return (
        window as Window & {
          __SKRIBEUM_E2E_SET_SELECTION__?: (anchor: number) => boolean;
        }
      ).__SKRIBEUM_E2E_SET_SELECTION__?.(0);
    });
    expect(movedToStart).toBe(true);
    await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      if (scroller === null) throw new Error("editor scroller missing");
      scroller.scrollTop = 0;
    });
    await viewportAfterPaint();
    const tag = $(".skr-editor-pane-focused .cm-skr-tag");
    await tag.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "tag source did not scroll into view",
    });
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
    await typeTagCompletionQuery(packagedTagCompletionHarness);
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
    await $(
      `[role="treeitem"][data-path="${TAG_DELETE_NOTE_NAME}"]`,
    ).waitForExist({
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
    // the traversal order is header overflow, banners when present, tree,
    // editor.
    const tabOrderSound = await browser.execute(() => {
      const positive = [...document.querySelectorAll("[tabindex]")].some(
        (element) => Number(element.getAttribute("tabindex")) > 0,
      );
      const surfaces = [
        document.querySelector('header button[aria-label="More actions"]'),
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

    // The header overflow is keyboard-focusable.
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('header button[aria-label="More actions"]')
        ?.focus();
    });
    expect(await activeElementDescriptor()).toContain("button");

    // The tree exposes exactly one roving tabindex stop and arrow keys
    // move it; Enter opens the focused note.
    const firstTreeItem = $(`[role="treeitem"][data-path="${LF_NOTE_NAME}"]`);
    await firstTreeItem.click();
    // A synthesized click's resulting focus event is delivered by the
    // native webview asynchronously; document.activeElement can briefly
    // still read as body immediately after the click command resolves, so
    // this polls for the condition rather than asserting on the first read.
    await browser.waitUntil(
      async () => (await activeElementDescriptor()).includes("treeitem"),
      {
        timeout: 5000,
        timeoutMsg: "tree item did not receive focus after being clicked",
      },
    );
    const beforeArrow = await activeElementDescriptor();
    await browser.keys(Key.ArrowDown);
    const afterArrow = await activeElementDescriptor();
    expect(afterArrow).toContain("treeitem");
    expect(afterArrow).not.toBe(beforeArrow);
    await browser.execute((noteName: string) => {
      document
        .querySelector<HTMLElement>(
          `[role="treeitem"][data-path="${noteName}"]`,
        )
        ?.focus();
    }, LF_NOTE_NAME);
    expect(
      await browser.execute(() =>
        document.activeElement?.getAttribute("data-path"),
      ),
    ).toBe(LF_NOTE_NAME);
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      async () =>
        (await $(".skr-editor-pane-focused .skr-editor-shell").getAttribute(
          "data-note-path",
        )) === LF_NOTE_NAME && (await editorText()).includes("alpha"),
      {
        timeout: 15000,
      },
    );

    // The editor is keyboard-focusable with a visible focus indicator, and
    // typing lands in the document.
    const editorFocused = await browser.execute(() => {
      return (
        window as Window & {
          __SKRIBEUM_E2E_SET_SELECTION__?: (anchor: number) => boolean;
        }
      ).__SKRIBEUM_E2E_SET_SELECTION__?.(0);
    });
    expect(editorFocused).toBe(true);
    expect(
      await browser.execute(() => {
        const content = document.querySelector<HTMLElement>(".cm-content");
        return (
          content?.getAttribute("contenteditable") === "true" &&
          content.tabIndex === 0
        );
      }),
    ).toBe(true);
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
          // The glyph is played rather than transitioned, because the view
          // rebuilds the node whenever its decoration class changes and a
          // transition would have no starting value to run from.
          settled: marker.getAnimations().length === 0,
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
    // At rest the glyph waits 0.25rem (4px) toward the reading direction,
    // ready to translate into its reserved space on reveal.
    expect(hidden?.transform).toBe("matrix(1, 0, 0, 1, 4, 0)");
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
    await browser.waitUntil(
      async () => (await headingMarkerState())?.settled === true,
      {
        timeout: 10000,
        timeoutMsg: "heading marker did not settle after revealing",
      },
    );
    const revealed = await headingMarkerState();
    // Settled active glyph: fully opaque and translated home.
    expect(revealed?.opacity).toBe("1");
    expect(revealed?.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
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
    expect(await checkbox.getAttribute("aria-label")).toBe("Todo");

    await hoverTaskCheckbox();
    const hoverState = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>(".cm-skr-task-control");
      if (host === null) {
        return null;
      }
      const liveCheckbox = host.querySelector<HTMLElement>(
        ".cm-skr-task-checkbox",
      );
      const listbox = host.querySelector<HTMLElement>('[role="listbox"]');
      const state = {
        expanded: liveCheckbox?.getAttribute("aria-expanded"),
        hidden: listbox?.hidden,
        optionCount: listbox?.querySelectorAll('[role="option"]').length,
      };
      const bounds = liveCheckbox?.getBoundingClientRect();
      liveCheckbox?.dispatchEvent(
        new PointerEvent("pointerleave", {
          bubbles: true,
          clientX: (bounds?.right ?? 0) + 1,
          clientY: (bounds?.bottom ?? 0) + 1,
          pointerType: "mouse",
        }),
      );
      return state;
    });
    expect(hoverState).toEqual({
      expanded: "true",
      hidden: false,
      optionCount: 10,
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
    await input.addValue("task cancelled");
    await browser.waitUntil(
      async () => (await $$('[role="option"]').length) === 1,
      { timeout: 10000 },
    );
    expect(await $('[role="option"]').getText()).toContain("Task: Cancelled");
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

  it("opens_task_status_by_contextual_overflow_row_and_applies_by_tap", async () => {
    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    await $(".cm-skr-task-checkbox").waitForExist({ timeout: 15000 });

    await placeCursorAtLineEnd("Review task");
    await $('button[aria-label="More actions"]').click();
    let menu = $('[data-testid="anchored-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    expect(
      await menu.$('[data-command-id="task.set-status"]').isDisplayed(),
    ).toBe(true);
    await browser.keys(Key.Escape);

    await browser.keys([modifierKey, "e"]);
    await $('[data-testid="source-mode-chip"]').waitForDisplayed({
      timeout: 10000,
    });
    await $('button[aria-label="More actions"]').click();
    menu = $('[data-testid="anchored-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    const sourceTaskRoute = menu.$('[data-command-id="task.set-status"]');
    await sourceTaskRoute.waitForDisplayed({ timeout: 10000 });
    await sourceTaskRoute.click();
    const sourceListbox = $(".cm-skr-task-palette");
    await sourceListbox.waitForDisplayed({ timeout: 10000 });
    expect(await $('[data-testid="source-mode-chip"]').isDisplayed()).toBe(
      true,
    );
    await browser.keys(Key.Escape);
    await browser.keys([modifierKey, "e"]);
    await $(".cm-skr-task-checkbox").waitForExist({ timeout: 10000 });

    await placeCursorAtLineEnd("body text here");
    await $('button[aria-label="More actions"]').click();
    menu = $('[data-testid="anchored-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    expect(
      await menu.$('[data-command-id="task.set-status"]').isExisting(),
    ).toBe(false);
    await browser.keys(Key.Escape);
    await menu.waitForExist({ reverse: true, timeout: 10000 });

    await browser.execute(() => {
      document.querySelector<HTMLElement>(".cm-skr-task-checkbox")?.focus();
    });
    await $('button[aria-label="More actions"]').click();
    menu = $('[data-testid="anchored-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    expect(
      await menu.$('[data-command-id="task.set-status"]').isDisplayed(),
    ).toBe(true);
    const taskRoute = menu.$('[data-command-id="task.set-status"]');
    await taskRoute.waitForDisplayed({ timeout: 10000 });
    await taskRoute.click();
    const listbox = $(".cm-skr-task-palette");
    await listbox.waitForDisplayed({ timeout: 10000 });
    // Confirms the palette does not close itself and nothing writes to
    // disk on its own within a short window; there is no condition to
    // wait for here since the assertions are checking that nothing
    // happens, not that something does.
    await browser.pause(100);
    expect(await listbox.isDisplayed()).toBe(true);
    expect(noteOnDisk(LIVE_PREVIEW_NOTE_NAME)).toBe(LIVE_PREVIEW_NOTE_CONTENT);
    await browser.execute(() => {
      document
        .querySelector(".skr-note-title-region")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await listbox.waitForDisplayed({ reverse: true, timeout: 10000 });
    expect(noteOnDisk(LIVE_PREVIEW_NOTE_NAME)).toBe(LIVE_PREVIEW_NOTE_CONTENT);

    await $('button[aria-label="More actions"]').click();
    menu = $('[data-testid="anchored-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    await menu.$('[data-command-id="task.set-status"]').click();
    await listbox.waitForDisplayed({ timeout: 10000 });
    await browser.keys(Key.Escape);
    await listbox.waitForDisplayed({ reverse: true, timeout: 10000 });
    expect(noteOnDisk(LIVE_PREVIEW_NOTE_NAME)).toBe(LIVE_PREVIEW_NOTE_CONTENT);

    await browser.keys([modifierKey, "p"]);
    const commandInput = $('[role="combobox"]');
    await commandInput.waitForDisplayed({ timeout: 10000 });
    await commandInput.addValue("task set status");
    await browser.waitUntil(
      async () =>
        (await $('[role="option"][aria-selected="true"]').getText()).includes(
          "Task: set status",
        ),
      { timeout: 10000, timeoutMsg: "task status route was not selected" },
    );
    await browser.keys(Key.Enter);
    await listbox.waitForDisplayed({ timeout: 10000 });
    expect(
      await browser.execute(() =>
        document.activeElement?.classList.contains("cm-skr-task-palette"),
      ),
    ).toBe(true);
    await browser.keys(Key.Escape);
    await listbox.waitForDisplayed({ reverse: true, timeout: 10000 });

    await $('button[aria-label="More actions"]').click();
    menu = $('[data-testid="anchored-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    await menu.$('[data-command-id="task.set-status"]').click();
    await listbox.waitForDisplayed({ timeout: 10000 });
    const cancelledStatus = $(
      '.cm-skr-task-palette [role=option][data-task-status="-"]',
    );
    await cancelledStatus.waitForDisplayed({ timeout: 10000 });
    expect(await cancelledStatus.getText()).toContain("Cancelled");
    await cancelledStatus.click();
    await browser.waitUntil(
      () => noteOnDisk(LIVE_PREVIEW_NOTE_NAME).includes("- [-] Review task"),
      { timeout: 10000, timeoutMsg: "task status tap did not persist" },
    );
    await $(".cm-skr-task-checkbox").click();
    await waitForDisk(LIVE_PREVIEW_NOTE_NAME, LIVE_PREVIEW_NOTE_CONTENT);
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
      outcome: "advance" | "cancel" | "cancelled",
    ): Promise<TaskGestureObservation> =>
      browser.executeAsync<
        TaskGestureObservation,
        ["advance" | "cancel" | "cancelled"]
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
          const cancelled = [
            ...menu.querySelectorAll<HTMLElement>('[role="option"]'),
          ].find((candidate) => candidate.textContent?.includes("Cancelled"));
          const target =
            requestedOutcome === "cancelled" && cancelled !== undefined
              ? cancelled.getBoundingClientRect()
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
    const cancelledSelection = await taskGesture("cancelled");
    expect(cancelledSelection.menuOpened).toBe(true);
    expect(cancelledSelection.noOptionUnderPress).toBe(true);
    expect(cancelledSelection.menuGap).toBe(true);
    expect(cancelledSelection.activeOption).toContain("option-3");
    await browser.waitUntil(
      () => noteOnDisk(LIVE_PREVIEW_NOTE_NAME).includes("- [-] Review task"),
      {
        timeout: 10000,
        timeoutMsg: "task drag release did not apply Cancelled",
      },
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
    // Confirms the cancelled gesture never triggers a write: waits past
    // the 400ms autosave debounce (settings.autosave_delay_ms) with
    // margin, since there is no pending-edit signal to poll for an
    // action that correctly produced no edit.
    await browser.pause(700);
    expect(noteOnDisk(LIVE_PREVIEW_NOTE_NAME)).toBe(LIVE_PREVIEW_NOTE_CONTENT);
  });

  it("keeps_construct_geometry_stable_during_cross_construct_selection", async () => {
    await openNoteFromTree(TASK_TRACKS_NOTE_NAME);
    await $(".cm-line.cm-skr-rich-callout").waitForExist({ timeout: 15000 });
    type GeometryFrame = {
      boxes: Array<{
        height: number;
        key: string;
        left: number;
        top: number;
        width: number;
      }>;
      revealed: boolean;
      selectionLength: number;
    };
    const frames = await browser.executeAsync<GeometryFrame[], []>((done) => {
      const root = document.querySelector(".cm-content");
      if (root === null) throw new Error("editor content missing");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        if (
          node instanceof Text &&
          (node.textContent?.length ?? 0) > 0 &&
          node.parentElement?.closest('[contenteditable="false"]') === null
        ) {
          textNodes.push(node);
        }
      }
      const anchor = textNodes.find((node) =>
        node.textContent?.includes("Task track fixture"),
      );
      const focus = textNodes.find((node) =>
        node.textContent?.includes("Reference item"),
      );
      if (anchor === undefined || focus === undefined) {
        throw new Error("selection endpoints missing");
      }
      const anchorIndex = textNodes.indexOf(anchor);
      const focusIndex = textNodes.indexOf(focus);
      const path = textNodes.slice(anchorIndex, focusIndex + 1);
      const selection = window.getSelection();
      if (selection === null) throw new Error("selection unavailable");
      const observations: GeometryFrame[] = [];
      const record = () => {
        const elements = [
          ...document.querySelectorAll<HTMLElement>(
            ".cm-skr-heading, .cm-line.cm-skr-rich-callout, .cm-skr-task-control",
          ),
        ];
        observations.push({
          boxes: elements.map((element, index) => {
            const box = element.getBoundingClientRect();
            return {
              height: box.height,
              key: `${element.className}:${index}`,
              left: box.left,
              top: box.top,
              width: box.width,
            };
          }),
          revealed:
            document.querySelector('[data-revealed="true"]') !== null ||
            document.querySelector(".cm-skr-reveal-source") !== null,
          selectionLength: selection.toString().length,
        });
      };
      selection.setBaseAndExtent(anchor, 0, anchor, 0);
      document.dispatchEvent(new Event("selectionchange"));
      record();
      let index = 0;
      const step = () => {
        const target = path[index];
        if (target === undefined) {
          done(observations);
          return;
        }
        selection.setBaseAndExtent(
          anchor,
          0,
          target,
          target.textContent?.length ?? 0,
        );
        document.dispatchEvent(new Event("selectionchange"));
        requestAnimationFrame(() => {
          record();
          index += 1;
          step();
        });
      };
      step();
    });
    expect(frames.length).toBeGreaterThan(4);
    const baseline = frames[0]?.boxes;
    expect(baseline).toBeDefined();
    expect(frames[0]?.selectionLength).toBe(0);
    expect(frames.slice(1).every((frame) => frame.selectionLength > 0)).toBe(
      true,
    );
    for (const frame of frames) {
      expect(frame.boxes).toEqual(baseline);
      expect(frame.revealed).toBe(false);
    }

    await placeCursorInsideEditorText("Callout body");
    await browser.waitUntil(
      async () =>
        await $(
          '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
        ).isExisting(),
      { timeout: 10000, timeoutMsg: "collapsed caret did not reveal callout" },
    );
    await placeCursorAtLineEnd("selection parking");
  });

  it("persists_task_tracks_payloads_and_marker_editing_as_exact_text", async () => {
    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    writeFileSync(
      path.join(SCRATCH_VAULT_PATH, TASK_TRACKS_NOTE_NAME),
      TASK_TRACKS_NOTE_CONTENT,
    );
    await openNoteFromTree(TASK_TRACKS_NOTE_NAME);
    await $(".cm-skr-task-checkbox").waitForExist({ timeout: 15000 });

    await hoverTaskCheckbox();
    const groupedMenu = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>(".cm-skr-task-control");
      return {
        headings: [
          ...document.querySelectorAll<HTMLElement>(
            "[data-task-track-heading]",
          ),
        ].map((heading) => heading.textContent ?? ""),
        rows: host?.querySelectorAll('[role="option"]').length ?? 0,
      };
    });
    expect(groupedMenu).toEqual({
      headings: ["Task", "Time", "Importance", "Reference"],
      rows: 10,
    });
    await $(".skr-app-header").moveTo();

    let task = $('.cm-skr-task-checkbox[data-track="task"]');
    await task.click();
    await browser.waitUntil(
      () => noteOnDisk(TASK_TRACKS_NOTE_NAME).includes("- [/] Editable task"),
      { timeout: 10000 },
    );
    task = $('.cm-skr-task-checkbox[data-track="task"]');
    await browser.execute(() =>
      document
        .querySelector<HTMLElement>('.cm-skr-task-checkbox[data-track="task"]')
        ?.focus(),
    );
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      () => noteOnDisk(TASK_TRACKS_NOTE_NAME).includes("- [x] Editable task"),
      { timeout: 10000 },
    );

    const importance = $('.cm-skr-task-checkbox[data-track="importance"]');
    for (const expected of ["⏫", "🔼", "🔽"]) {
      await importance.click();
      await browser.waitUntil(
        () =>
          noteOnDisk(TASK_TRACKS_NOTE_NAME).includes(
            `- [!] Important item ${expected}`,
          ),
        { timeout: 10000 },
      );
    }
    await importance.click();
    await browser.waitUntil(
      () =>
        noteOnDisk(TASK_TRACKS_NOTE_NAME).includes("- [!] Important item\n"),
      { timeout: 10000 },
    );

    await browser.executeAsync<void, []>((done) => {
      const box = document.querySelector<HTMLElement>(
        '.cm-skr-task-checkbox[data-track="time"]',
      );
      if (box === null) throw new Error("time checkbox missing");
      const bounds = box.getBoundingClientRect();
      const pointerId = 77;
      const dispatch = (type: string, x: number, y: number) =>
        box.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId,
            pointerType: "touch",
          }),
        );
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      dispatch("pointerdown", x, y);
      setTimeout(() => {
        const due = [
          ...document.querySelectorAll<HTMLElement>(
            ".cm-skr-task-palette [role=option]",
          ),
        ].find((option) => option.textContent?.includes("Due"));
        if (due === undefined) throw new Error("Due option missing");
        const target = due.getBoundingClientRect();
        const targetX = target.left + target.width / 2;
        const targetY = target.top + target.height / 2;
        dispatch("pointermove", targetX, targetY);
        dispatch("pointerup", targetX, targetY);
        done();
      }, 550);
    });
    const date = $('[data-testid="task-date-payload"]');
    await date.waitForExist({ timeout: 10000 });
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="task-date-payload"]',
      );
      if (input === null) throw new Error("date field missing");
      input.value = "2031-04-05";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await browser.waitUntil(
      () =>
        noteOnDisk(TASK_TRACKS_NOTE_NAME).includes(
          "- [D] Dated item 📅 2031-04-05",
        ),
      { timeout: 10000 },
    );
    expect(await $(".cm-skr-task-payload").getText()).toBe("📅 2031-04-05");

    await placeCursorAtLineEnd("Dated item 📅 2031-04-05");
    await browser.keys(Key.Enter);
    expect(
      await browser.execute(
        () =>
          document.querySelectorAll(
            '.cm-skr-task-checkbox[data-track="time"][data-task="D"]',
          ).length,
      ),
    ).toBe(2);
    await browser.keys(Key.Backspace);
    await browser.keys([modifierKey, "s"]);
    await browser.waitUntil(
      () => {
        const lines = noteOnDisk(TASK_TRACKS_NOTE_NAME).split("\n");
        const dated = lines.indexOf("- [D] Dated item 📅 2031-04-05");
        return lines[dated + 1] === "";
      },
      { timeout: 10000, timeoutMsg: "inherited marker left residual bytes" },
    );

    await placeCursorAtEditorTextStart("Editable task");
    await browser.keys(Key.Backspace);
    await browser.keys([modifierKey, "s"]);
    await browser.waitUntil(
      () =>
        noteOnDisk(TASK_TRACKS_NOTE_NAME)
          .split("\n")
          .includes("- [x]Editable task"),
      { timeout: 10000, timeoutMsg: "task source did not preserve its status" },
    );
    for (let press = 0; press < 5; press += 1) {
      await browser.keys(Key.Backspace);
    }
    await browser.keys([modifierKey, "s"]);
    await browser.waitUntil(
      () =>
        noteOnDisk(TASK_TRACKS_NOTE_NAME).split("\n").includes("Editable task"),
      { timeout: 10000, timeoutMsg: "task marker did not delete by source" },
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
      // calloutVisualIdentity reads the first `.cm-skr-rich-callout` line
      // in DOM order, not specifically the one the waitForExist above
      // just confirmed carries data-revealed="true": a multi-line callout
      // reveals its lines one at a time, so the first line in DOM order
      // can still be mid-reveal for a moment after some other line in the
      // callout has already flipped. Poll this read instead of taking it
      // once immediately after the DOM-existence wait above.
      let revealedIdentity: Awaited<ReturnType<typeof calloutVisualIdentity>> =
        null;
      await browser.waitUntil(
        async () => {
          revealedIdentity = await calloutVisualIdentity();
          return revealedIdentity?.revealed === true;
        },
        {
          timeout: 5000,
          timeoutMsg: `${testCase.point} click did not settle the callout's revealed identity`,
        },
      );
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
    await placeCursorAtLineEnd("[Outside link](outside-target)");
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

  it("resolves_state_surface_and_panel_motion_from_the_built_theme", async () => {
    await openNoteFromTree(VISUAL_NOTE_NAME);
    await $(".skr-properties-reveal").waitForExist({ timeout: 15000 });
    await browser.keys([modifierKey, "k"]);
    await $(".command-surface-dialog").waitForExist({ timeout: 5000 });
    await waitForSurfaceEntrance(".command-surface-dialog");

    const measurements = await browser.execute(() => {
      const state = document.querySelector<HTMLElement>(".skr-header-overflow");
      const surface = document.querySelector<HTMLElement>(
        ".command-surface-dialog",
      );
      const panel = document.querySelector<HTMLElement>(
        ".skr-properties-reveal",
      );
      const outlinePanel = document.querySelector<HTMLElement>(
        '[data-testid="desktop-outline-panel"]',
      );
      if (
        state === null ||
        surface === null ||
        panel === null ||
        outlinePanel === null
      ) {
        throw new Error("motion class fixture missing");
      }
      const stateStyle = getComputedStyle(state);
      const surfaceStyle = getComputedStyle(surface);
      const panelStyle = getComputedStyle(panel);
      const outlinePanelStyle = getComputedStyle(outlinePanel);
      return {
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        state: {
          duration: stateStyle.transitionDuration,
          easing: stateStyle.transitionTimingFunction,
          properties: stateStyle.transitionProperty,
        },
        surface: {
          duration: surfaceStyle.transitionDuration,
          easing: surfaceStyle.transitionTimingFunction,
          properties: surfaceStyle.transitionProperty,
        },
        panel: {
          duration: panelStyle.transitionDuration,
          easing: panelStyle.transitionTimingFunction,
          properties: panelStyle.transitionProperty,
        },
        outlinePanel: {
          duration: outlinePanelStyle.transitionDuration,
          easing: outlinePanelStyle.transitionTimingFunction,
          properties: outlinePanelStyle.transitionProperty,
        },
      };
    });

    expect(
      measurements.state.duration
        .split(",")
        .every(
          (value) =>
            value.trim() === (measurements.reducedMotion ? "0s" : "0.05s"),
        ),
    ).toBe(true);
    expect(
      measurements.state.easing
        .split(",")
        .every((value) => value.trim() === "linear"),
    ).toBe(true);
    expect(
      measurements.surface.duration
        .split(",")
        .every(
          (value) =>
            value.trim() === (measurements.reducedMotion ? "0s" : "0.12s"),
        ),
    ).toBe(true);
    expect(measurements.surface.easing).toBe(
      "cubic-bezier(0.2, 0, 0, 1), cubic-bezier(0.2, 0, 0, 1)",
    );
    expect(measurements.surface.properties).toBe("opacity, transform");
    expect(measurements.panel.duration).toBe(
      measurements.reducedMotion ? "0s" : "0.16s",
    );
    expect(measurements.panel.easing).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(measurements.panel.properties).toBe("grid-template-rows");
    expect(measurements.outlinePanel.duration).toBe(
      measurements.reducedMotion ? "0s" : "0.16s",
    );
    expect(measurements.outlinePanel.easing).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(measurements.outlinePanel.properties).toBe("width");

    const row = $('.command-surface-results [role="option"]');
    const rest = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>(
        '.command-surface-results [role="option"]',
      );
      if (element === null) throw new Error("command row missing");
      const box = element.getBoundingClientRect();
      return {
        box: [box.x, box.y, box.width, box.height],
        transform: getComputedStyle(element).transform,
      };
    });
    await row.moveTo();
    const hovered = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>(
        '.command-surface-results [role="option"]',
      );
      if (element === null) throw new Error("command row missing");
      const box = element.getBoundingClientRect();
      return {
        box: [box.x, box.y, box.width, box.height],
        transform: getComputedStyle(element).transform,
      };
    });
    expect(hovered).toEqual(rest);
    await browser.keys(Key.Escape);
    await $(".command-surface-dialog").waitForExist({
      reverse: true,
      timeout: 5000,
    });
    await setViewportSize(1000, 700);
    expect(
      await browser.execute(
        () =>
          getComputedStyle(
            document.querySelector(
              '[data-testid="desktop-outline-panel"]',
            ) as Element,
          ).transitionDuration,
      ),
    ).toBe("0s");
    await restoreDesktopViewport();
  });

  it("uses_only_compositor_motion_during_an_anchored_menu_entrance", async () => {
    await restoreDesktopViewport();
    const reducedMotion = await browser.execute(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    type MenuFrame = {
      layout: [number, number];
      neighbor: [number, number, number, number];
      opacity: string;
      properties: string;
      transform: string;
      visualTop: number;
    };
    const frames = await browser.executeAsync<MenuFrame[], []>((done) => {
      const trigger = document.querySelector<HTMLButtonElement>(
        ".skr-header-overflow",
      );
      const neighbor = document.querySelector<HTMLElement>(
        '[data-testid="reading-surface"]',
      );
      if (trigger === null || neighbor === null) {
        throw new Error("menu fixture missing");
      }
      const observations: MenuFrame[] = [];
      let observedAt: number | undefined;
      const sample = () => {
        const menu = document.querySelector<HTMLElement>(
          '[data-testid="anchored-menu"]',
        );
        if (menu === null) {
          requestAnimationFrame(sample);
          return;
        }
        observedAt ??= performance.now();
        const neighborBox = neighbor.getBoundingClientRect();
        const menuBox = menu.getBoundingClientRect();
        const style = getComputedStyle(menu);
        observations.push({
          layout: [menu.offsetWidth, menu.offsetHeight],
          neighbor: [
            neighborBox.x,
            neighborBox.y,
            neighborBox.width,
            neighborBox.height,
          ],
          opacity: style.opacity,
          properties: style.transitionProperty,
          transform: style.transform,
          visualTop: menuBox.top,
        });
        if (performance.now() - observedAt >= 180) {
          done(observations);
          return;
        }
        requestAnimationFrame(sample);
      };
      trigger.click();
      requestAnimationFrame(sample);
    });

    expect(frames.length).toBeGreaterThan(1);
    expect(
      frames.every((frame) => frame.properties === "opacity, transform"),
    ).toBe(true);
    expect(
      frames.every(
        (frame) => frame.layout.toString() === frames.at(-1)?.layout.toString(),
      ),
    ).toBe(true);
    expect(
      frames.every(
        (frame) =>
          frame.neighbor.toString() === frames.at(-1)?.neighbor.toString(),
      ),
    ).toBe(true);
    const distinctOpacity = new Set(frames.map((frame) => frame.opacity)).size;
    const distinctTransform = new Set(frames.map((frame) => frame.transform))
      .size;
    const distinctVisualTop = new Set(frames.map((frame) => frame.visualTop))
      .size;
    if (reducedMotion) {
      expect(distinctOpacity).toBe(1);
      expect(distinctTransform).toBe(1);
      expect(distinctVisualTop).toBe(1);
    } else {
      expect(distinctOpacity).toBeGreaterThan(1);
      expect(distinctTransform).toBeGreaterThan(1);
      expect(distinctVisualTop).toBeGreaterThan(1);
    }
    await browser.keys(Key.Escape);
  });

  it("keeps_direct_manipulation_geometry_instant", async () => {
    await openNoteFromTree(TABLE_EDITING_NOTE_NAME);
    await $(".cm-skr-table-grid").waitForExist({ timeout: 15000 });

    const snapshots = await browser.execute(() => {
      const marker = document.createElement("span");
      marker.className = "cm-skr-reveal-marker";
      document.body.append(marker);
      const editor = document.querySelector(".cm-editor");
      const selection = document.createElement("div");
      selection.className = "cm-selectionBackground";
      editor?.append(selection);
      const caret = document.createElement("div");
      caret.className = "cm-cursor";
      editor?.append(caret);
      const focusRing = document.querySelector(".skr-header-overflow");
      const sourceMode = document.querySelector(".editor");
      const treeItem = document.createElement("div");
      treeItem.setAttribute("role", "treeitem");
      treeItem.setAttribute("aria-expanded", "true");
      const treeChevron = document.createElement("span");
      treeItem.append(treeChevron);
      document.body.append(treeItem);
      const tableTrack = document.querySelector(".cm-skr-table-row");
      const pointerGeometry = document.querySelector(".cm-skr-table-insert");
      const scroller = document.querySelector(".cm-scroller");
      if (
        editor === null ||
        focusRing === null ||
        sourceMode === null ||
        treeChevron === null ||
        tableTrack === null ||
        pointerGeometry === null ||
        scroller === null
      ) {
        throw new Error("direct manipulation fixture is incomplete");
      }
      document.documentElement.dataset.themeSwitching = "true";
      const result = {
        caret: {
          duration: getComputedStyle(caret).transitionDuration,
          properties: getComputedStyle(caret).transitionProperty,
        },
        selection: {
          duration: getComputedStyle(selection).transitionDuration,
          properties: getComputedStyle(selection).transitionProperty,
        },
        focusRing: {
          duration: getComputedStyle(focusRing).transitionDuration,
          properties: getComputedStyle(focusRing).transitionProperty,
        },
        revealGeometry: {
          duration: getComputedStyle(marker).transitionDuration,
          properties: getComputedStyle(marker).transitionProperty,
        },
        sourceMode: {
          duration: getComputedStyle(sourceMode).transitionDuration,
          properties: getComputedStyle(sourceMode).transitionProperty,
        },
        treeChevron: {
          duration: getComputedStyle(treeChevron).transitionDuration,
          properties: getComputedStyle(treeChevron).transitionProperty,
        },
        tableTrack: {
          duration: getComputedStyle(tableTrack).transitionDuration,
          properties: getComputedStyle(tableTrack).transitionProperty,
        },
        pointerGeometry: {
          duration: getComputedStyle(pointerGeometry).transitionDuration,
          properties: getComputedStyle(pointerGeometry).transitionProperty,
        },
        scrollBehavior: getComputedStyle(scroller).scrollBehavior,
        theme: {
          duration: getComputedStyle(focusRing).transitionDuration,
          properties: getComputedStyle(focusRing).transitionProperty,
        },
      };
      delete document.documentElement.dataset.themeSwitching;
      marker.remove();
      selection.remove();
      caret.remove();
      treeItem.remove();
      return result;
    });

    const instant = {
      caret: effectiveTransitionDuration(snapshots.caret, "transform"),
      selection: effectiveTransitionDuration(
        snapshots.selection,
        "background-color",
      ),
      focusRing: effectiveTransitionDuration(
        snapshots.focusRing,
        "outline-color",
      ),
      revealGeometry: effectiveTransitionDuration(
        snapshots.revealGeometry,
        "width",
      ),
      sourceMode: effectiveTransitionDuration(snapshots.sourceMode, "display"),
      treeChevron: effectiveTransitionDuration(
        snapshots.treeChevron,
        "transform",
      ),
      tableTrack: effectiveTransitionDuration(
        snapshots.tableTrack,
        "grid-template-columns",
      ),
      pointerGeometry: effectiveTransitionDuration(
        snapshots.pointerGeometry,
        "inset",
      ),
      scrollBehavior: snapshots.scrollBehavior,
      theme: effectiveTransitionDuration(snapshots.theme, "background-color"),
    };

    expect(
      Object.values(instant).every(
        (value) => value === "0s" || value === "auto",
      ),
    ).toBe(true);
  });

  it("zeros_motion_classes_and_stops_the_pulse_under_both_reduction_routes", async () => {
    await openNoteFromTree(VISUAL_NOTE_NAME);
    await $(".skr-properties-reveal").waitForExist({ timeout: 15000 });

    const reduction = await browser.execute(() => {
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
      if (mediaRules.length === 0)
        throw new Error("reduced-motion rules missing");

      const surface = document.createElement("div");
      surface.dataset.motionSurface = "centered";
      surface.dataset.motionEntered = "true";
      const pulse = document.createElement("span");
      pulse.className = "skr-skeleton-bar";
      document.body.append(surface, pulse);
      const read = () => ({
        state: getComputedStyle(
          document.querySelector(".skr-header-overflow") as Element,
        ).transitionDuration,
        surface: getComputedStyle(surface).transitionDuration,
        panel: getComputedStyle(
          document.querySelector(".skr-properties-reveal") as Element,
        ).transitionDuration,
        pulse: getComputedStyle(pulse).animationName,
        pulseOpacity: getComputedStyle(pulse).opacity,
      });

      reducedStyle.textContent = mediaRules.join("\n");
      document.head.append(reducedStyle);
      const media = read();
      reducedStyle.remove();
      document.documentElement.dataset.animations = "false";
      const setting = read();
      document.documentElement.dataset.animations = "true";
      surface.remove();
      pulse.remove();
      return { media, setting };
    });

    for (const route of [reduction.media, reduction.setting]) {
      expect(
        route.state.split(",").every((value) => value.trim() === "0s"),
      ).toBe(true);
      expect(
        route.surface.split(",").every((value) => value.trim() === "0s"),
      ).toBe(true);
      expect(route.panel).toBe("0s");
      expect(route.pulse).toBe("none");
      expect(route.pulseOpacity).toBe("0.7");
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
    // Wait for any preceding save to actually land before removing the
    // note externally, so the removal classifies as an external change
    // rather than racing an edit of our own write.
    await waitForActiveTabSaved();
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

  async function closeIfOpen(selector: string) {
    const surface = $(selector);
    if (!(await surface.isExisting())) return;
    // Escape can dismiss one nested layer at a time (the settings dialog's
    // own jump menu, for one), so press it until the surface itself is
    // gone rather than assuming a single press clears it.
    await browser.waitUntil(
      async () => {
        if (!(await surface.isExisting())) return true;
        await browser.keys(Key.Escape);
        return false;
      },
      { timeout: 5000, interval: 200 },
    );
  }

  /** Restores `window.matchMedia` after a test patches it to simulate an OS
   * colour-scheme change (see palette_selection_and_system_matching_round_trip_stored_fields). */
  async function restoreNativeMatchMedia() {
    await browser.execute(() => {
      const testWindow = window as unknown as {
        __skribeumColourSchemeQuery?: MediaQueryList;
        __skribeumNativeMatchMedia?: typeof window.matchMedia;
      };
      if (testWindow.__skribeumNativeMatchMedia !== undefined) {
        window.matchMedia = testWindow.__skribeumNativeMatchMedia;
      }
      delete testWindow.__skribeumColourSchemeQuery;
      delete testWindow.__skribeumNativeMatchMedia;
    });
  }

  // A test that throws mid-way leaves whatever it opened or patched behind:
  // an open overlay or dialog blocks the next test's own surface from
  // opening, and a patched window.matchMedia feeds it a fake colour-scheme
  // query. Without this, one test's failure cascades into an unrelated
  // failure on whatever runs next, in the same session. Each helper is a
  // no-op when the test already cleaned up after itself.
  afterEach(async () => {
    await closeAnyOverlay();
    await closeIfOpen('[data-testid="settings-view"]');
    await closeIfOpen('[data-testid="dialog"]');
    await restoreNativeMatchMedia();
    // A test that throws between a narrow-viewport check and its restore
    // would otherwise run every following test at phone width.
    await restoreDesktopViewport();
  });

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
    const historyState = await capturedHistoryState();
    if (historyState === null) throw new Error("editor history state missing");
    const selected = await browser.execute((anchor: number) => {
      return (
        window as Window & {
          __SKRIBEUM_E2E_SET_SELECTION__?: (anchor: number) => boolean;
        }
      ).__SKRIBEUM_E2E_SET_SELECTION__?.(anchor);
    }, historyState.anchor);
    expect(selected).toBe(true);
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
    await restoreDesktopViewport();
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
    await pressFocusedKey("Enter");
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
    await pressFocusedKey("ArrowDown");
    await pressFocusedKey("Enter");
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

    const dialogGeometry = await browser.execute(() => {
      const settings = document.querySelector<HTMLElement>(
        '[data-testid="settings-view"]',
      );
      if (settings === null) throw new Error("settings dialog is missing");
      const box = settings.getBoundingClientRect();
      return {
        height: box.height,
        width: box.width,
        expectedHeight: Math.min(window.innerHeight * 0.85, 48 * 16),
        expectedWidth: Math.min(48 * 16, window.innerWidth - 2 * 16),
        versionHomes: [
          ...settings.querySelectorAll<HTMLElement>(
            '[data-setting-id$=".version"]',
          ),
        ].map(({ dataset }) => dataset.settingId),
      };
    });
    expect(
      Math.abs(dialogGeometry.height - dialogGeometry.expectedHeight),
    ).toBeLessThan(1);
    expect(
      Math.abs(dialogGeometry.width - dialogGeometry.expectedWidth),
    ).toBeLessThan(1);
    expect(dialogGeometry.versionHomes).toEqual(["updates.version"]);

    await setViewportSize(390, 844);
    const cardGeometry = await browser.execute(() => {
      const cards = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="settings-palette"] .palette-card',
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
    expect(cardGeometry).toEqual({ count: 6, firstRow: 2 });
    expect(await horizontalViewportEscapes()).toEqual([]);

    const previewColors = async () =>
      browser.execute(() => {
        const preview = document.querySelector<HTMLElement>(
          '[data-testid="settings-palette-preview"]',
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
          throw new Error("palette preview is incomplete");
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

    const manuscript = $('[data-testid="settings-palette-manuscript"]');
    await manuscript.scrollIntoView();
    await selectSettingsChoice(
      '[data-testid="settings-palette-manuscript"]',
      "Manuscript palette",
    );
    expect(
      await browser.execute(() => {
        const preview = document.querySelector<HTMLElement>(
          '[data-testid="settings-palette-preview"]',
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
    const studio = $('[data-testid="settings-palette-studio"]');
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
      '[data-testid="settings-palette-manuscript"]',
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
    const historyState = await capturedHistoryState();
    if (historyState === null) throw new Error("editor history state missing");
    const selected = await browser.execute((anchor: number) => {
      return (
        window as Window & {
          __SKRIBEUM_E2E_SET_SELECTION__?: (anchor: number) => boolean;
        }
      ).__SKRIBEUM_E2E_SET_SELECTION__?.(anchor);
    }, historyState.anchor);
    expect(selected).toBe(true);

    // The modal palette keeps Tab on its combobox and Escape returns focus
    // to the active workspace pane.
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
    const restoredFocus = await activeElementDescriptor();
    expect(
      restoredFocus.includes("cm-content") ||
        restoredFocus.includes("skr-pane-content"),
    ).toBe(true);

    // No element anywhere acquired a positive tabindex.
    const positive = await browser.execute(() =>
      [...document.querySelectorAll("[tabindex]")].some(
        (element) => Number(element.getAttribute("tabindex")) > 0,
      ),
    );
    expect(positive).toBe(false);
  });

  it("palette_selection_and_system_matching_round_trip_stored_fields", async () => {
    const original = await persistedSettings();
    if (typeof original === "string") throw new Error(original);
    const storedSystemSettings: SettingsDocument = {
      ...original,
      theme: "system",
      light_palette: "gazette",
      dark_palette: "signal",
    };
    await persistSettings(storedSystemSettings);
    await browser.refresh();
    await $('[role="tree"]').waitForExist({ timeout: 15000 });

    await browser.execute(`
      const nativeMatchMedia = window.matchMedia.bind(window);
      const media = "(prefers-color-scheme: dark)";
      const query = new EventTarget();
      Object.defineProperties(query, {
        matches: { configurable: true, value: false },
        media: { value: media },
        onchange: { value: null, writable: true },
      });
      window.matchMedia = function (queryText) {
        return queryText === media ? query : nativeMatchMedia(queryText);
      };
      window.__skribeumColourSchemeQuery = query;
      window.__skribeumNativeMatchMedia = nativeMatchMedia;
    `);

    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    // Each read re-queries: the settings surface re-renders as the document
    // commits, which detaches any handle held across a poll and turns a
    // "not settled yet" into a thrown stale-element error.
    const systemToggleSelected = () =>
      $('[data-testid="settings-match-system"]').isSelected();
    // The dialog's existence only means the container mounted; the controls
    // inside it commit the persisted document a moment later, so poll for
    // that committed state rather than asserting immediately on open.
    await browser.waitUntil(
      async () =>
        (await systemToggleSelected()) &&
        (await $('[data-testid="settings-palette-gazette"]').getAttribute(
          "aria-checked",
        )) === "true" &&
        (
          await $('[data-testid="settings-palette-signal"]').getAttribute(
            "class",
          )
        ).includes("paired"),
      {
        timeout: 10000,
        timeoutMsg: "settings surface did not commit the persisted document",
      },
    );

    await browser.execute(() => {
      const testWindow = window as unknown as {
        __skribeumColourSchemeQuery?: MediaQueryList;
      };
      const query = testWindow.__skribeumColourSchemeQuery;
      if (query === undefined)
        throw new Error("colour-scheme query is missing");
      Object.defineProperty(query, "matches", {
        configurable: true,
        value: true,
      });
      const event = new Event("change");
      Object.defineProperties(event, {
        matches: { value: true },
        media: { value: query.media },
      });
      query.dispatchEvent(event);
    });
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="settings-palette-signal"]').getAttribute(
          "aria-checked",
        )) === "true",
      {
        timeout: 5000,
        timeoutMsg: "system dark palette did not become active",
      },
    );
    expect(await systemToggleSelected()).toBe(true);
    expect(
      await browser.execute(() => document.documentElement.dataset.theme),
    ).toBe("system");

    await selectSettingsChoice(
      '[data-testid="settings-palette-graphite"]',
      "Graphite palette",
    );
    await browser.waitUntil(async () => !(await systemToggleSelected()), {
      timeout: 5000,
      timeoutMsg: "system match toggle stayed enabled",
    });
    expect(
      await browser.execute(() => ({
        theme: document.documentElement.dataset.theme,
        lightPalette: document.documentElement.dataset.lightPalette,
        darkPalette: document.documentElement.dataset.darkPalette,
      })),
    ).toEqual({
      theme: "dark",
      lightPalette: "gazette",
      darkPalette: "graphite",
    });
    await browser.waitUntil(
      async () => {
        const stored = await persistedSettings();
        return (
          typeof stored !== "string" &&
          stored.theme === "dark" &&
          stored.light_palette === "gazette" &&
          stored.dark_palette === "graphite"
        );
      },
      { timeout: 10000, timeoutMsg: "dark palette fields did not persist" },
    );

    await selectSettingsChoice(
      '[data-testid="settings-palette-studio"]',
      "Studio palette",
    );
    await $('[data-testid="settings-match-system"]').click();
    await browser.waitUntil(
      async () => {
        const stored = await persistedSettings();
        return (
          typeof stored !== "string" &&
          stored.theme === "system" &&
          stored.light_palette === "studio" &&
          stored.dark_palette === "graphite"
        );
      },
      {
        timeout: 10000,
        timeoutMsg: "system palette fields did not round-trip",
      },
    );

    await closeIfOpen('[data-testid="settings-view"]');
    await restoreNativeMatchMedia();
    await persistSettings(original);
    await browser.refresh();
    await $('[role="tree"]').waitForExist({ timeout: 15000 });
  });

  it("typed_slider_entry_commits_clamps_and_reverts", async () => {
    const original = await persistedSettings();
    if (typeof original === "string") throw new Error(original);
    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });

    let readout = $('[data-testid="settings-editor-font-size-readout"]');
    await readout.click();
    let entry = $('[data-testid="settings-editor-font-size-entry"]');
    await entry.waitForExist({ timeout: 5000 });
    await entry.setValue("24");
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      async () => {
        readout = $('[data-testid="settings-editor-font-size-readout"]');
        return (
          (await readout.isExisting()) &&
          (await readout.getText()).trim() === "24 px" &&
          (await persistedFontSize()) === 24
        );
      },
      { timeout: 10000, timeoutMsg: "typed font size did not commit" },
    );

    await readout.click();
    entry = $('[data-testid="settings-editor-font-size-entry"]');
    await entry.waitForExist({ timeout: 5000 });
    await entry.setValue("999");
    await $('[data-testid="settings-search"]').click();
    await browser.waitUntil(
      async () => {
        readout = $('[data-testid="settings-editor-font-size-readout"]');
        return (
          (await readout.isExisting()) &&
          (await readout.getText()).trim() === "40 px" &&
          (await persistedFontSize()) === 40
        );
      },
      { timeout: 10000, timeoutMsg: "typed font size did not clamp on blur" },
    );

    await readout.click();
    entry = $('[data-testid="settings-editor-font-size-entry"]');
    await entry.waitForExist({ timeout: 5000 });
    await entry.setValue("19");
    await browser.keys(Key.Escape);
    await browser.waitUntil(
      async () => {
        readout = $('[data-testid="settings-editor-font-size-readout"]');
        return (
          (await readout.isExisting()) &&
          (await readout.getText()).trim() === "40 px" &&
          (await persistedFontSize()) === 40
        );
      },
      { timeout: 10000, timeoutMsg: "typed font size did not revert" },
    );
    expect(await activeElementDescriptor()).toContain("numeric-readout");

    await browser.keys(Key.Escape);
    await dialog.waitForExist({ reverse: true, timeout: 5000 });
    await persistSettings(original);
    await browser.refresh();
    await $('[role="tree"]').waitForExist({ timeout: 15000 });
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
          appearance.darkPalette === "nightroom" &&
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

  it("renders_math_and_rethemes_lazy_mermaid_from_computed_tokens", async () => {
    const original = await persistedSettings();
    if (typeof original === "string") throw new Error(original);
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

    const mermaidColours = () =>
      browser.execute(() => {
        const host = document.querySelector<HTMLElement>(
          ".cm-skr-mermaid:not(.cm-skr-render-error)",
        );
        const node = host?.querySelector<SVGElement>(
          "g.node rect, g.node polygon, g.node path",
        );
        const edge = host?.querySelector<SVGElement>("path.flowchart-link");
        if (
          host === null ||
          host === undefined ||
          node === null ||
          edge === null
        ) {
          throw new Error("rendered Mermaid colours are unavailable");
        }
        const rootStyles = getComputedStyle(document.documentElement);
        const resolveColour = (value: string) => {
          const probe = document.createElement("span");
          probe.style.color = value;
          document.body.append(probe);
          const colour = getComputedStyle(probe).color;
          probe.remove();
          return colour;
        };
        return {
          fill: getComputedStyle(node).fill,
          stroke: getComputedStyle(edge).stroke,
          generation: host.dataset.mermaidThemeGeneration,
          tokenFill: resolveColour(
            rootStyles.getPropertyValue("--skr-surface-subtle"),
          ),
          tokenStroke: resolveColour(
            rootStyles.getPropertyValue("--skr-text-muted"),
          ),
        };
      });

    const before = await mermaidColours();
    expect(before.fill).toBe(before.tokenFill);
    expect(before.stroke).toBe(before.tokenStroke);

    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    await selectSettingsChoice(
      '[data-testid="settings-palette-signal"]',
      "Signal palette",
    );
    await browser.waitUntil(
      async () => {
        const appearance = await browser.execute(() => ({
          theme: document.documentElement.dataset.theme,
          palette: document.documentElement.dataset.darkPalette,
        }));
        return appearance.theme === "dark" && appearance.palette === "signal";
      },
      { timeout: 10000, timeoutMsg: "Signal palette tokens did not apply" },
    );
    const changedTokens = await mermaidColours();
    expect(changedTokens.tokenFill).not.toBe(before.tokenFill);
    expect(changedTokens.tokenStroke).not.toBe(before.tokenStroke);
    await browser.waitUntil(
      async () => (await mermaidColours()).generation !== before.generation,
      {
        timeout: 30000,
        timeoutMsg: "Mermaid did not render again for the palette",
      },
    );
    const after = await mermaidColours();
    expect(after.fill).toBe(after.tokenFill);
    expect(after.stroke).toBe(after.tokenStroke);
    expect(after.fill).not.toBe(before.fill);
    expect(after.stroke).not.toBe(before.stroke);

    await browser.keys(Key.Escape);
    await dialog.waitForExist({ reverse: true, timeout: 5000 });
    await persistSettings(original);
    await browser.refresh();
    await $('[role="tree"]').waitForExist({ timeout: 15000 });
  });

  it("contains_malicious_mermaid_configuration_and_resource_requests", async () => {
    await openNoteFromTree(RENDERING_NOTE_NAME);
    await browser.waitUntil(
      async () => {
        const states = await browser.execute(() =>
          [...document.querySelectorAll<HTMLElement>(".cm-skr-mermaid")].map(
            (host) =>
              host.classList.contains("cm-skr-render-error") ||
              host.querySelector("svg") !== null,
          ),
        );
        return states.length === 6 && states.every(Boolean);
      },
      {
        timeout: 30000,
        timeoutMsg: "Mermaid security fixtures did not settle",
      },
    );

    const result = await browser.execute(() => {
      const diagrams = [
        ...document.querySelectorAll<HTMLElement>(".cm-skr-mermaid"),
      ];
      const cssFixture = diagrams.at(-1);
      return {
        prototypePolluted: Object.hasOwn(
          Object.prototype,
          "mermaidPrototypePollutionMarker",
        ),
        cssFixtureContained:
          cssFixture?.classList.contains("cm-skr-render-error") ||
          (cssFixture?.querySelector("svg") !== null &&
            cssFixture.childElementCount === 1),
      };
    });

    expect(result.prototypePolluted).toBe(false);
    expect(result.cssFixtureContained).toBe(true);
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
    await waitForMotionSurfaceEntered(".command-surface-dialog");
    await expectNoAxeViolations("command palette");
    await browser.keys(Key.Escape);
    await $('[data-testid="unified-command-surface"]').waitForExist({
      reverse: true,
      timeout: 5000,
    });

    await browser.keys([modifierKey, ","]);
    await $('[data-testid="settings-view"]').waitForExist({ timeout: 10000 });
    await waitForMotionSurfaceEntered('[data-testid="settings-view"]');
    await expectNoAxeViolations("settings");
    await browser.keys(Key.Escape);
    await $('[data-testid="settings-view"]').waitForExist({
      reverse: true,
      timeout: 5000,
    });

    await openNoteFromTree(CANVAS_FILE_NAME);
    await $('[data-testid="canvas-view"]').waitForExist({ timeout: 15000 });
    await expectNoAxeViolations("canvas viewer");
  });

  it("keeps_undo_and_redo_after_an_autosave_is_observed_on_disk", async () => {
    await openNoteFromTree(DESKTOP_UNDO_NOTE_NAME);
    await browser.waitUntil(
      async () =>
        (await editorDocumentText()).trimEnd() ===
        DESKTOP_UNDO_NOTE_CONTENT.trimEnd(),
      { timeout: 15000, timeoutMsg: "desktop undo fixture did not open" },
    );
    await placeCursorAtLineEnd("undo base");
    await $(".cm-content").addValue("typed");
    const saved = `${DESKTOP_UNDO_NOTE_CONTENT.trimEnd()}typed\n`;
    await waitForDisk(DESKTOP_UNDO_NOTE_NAME, saved);
    await waitForUndoGroupSettle();

    expect((await editorDocumentText()).trimEnd()).toBe(saved.trimEnd());
    await pressEditorHistoryShortcut("undo");
    expect((await editorDocumentText()).trimEnd()).toBe(
      DESKTOP_UNDO_NOTE_CONTENT.trimEnd(),
    );
    await pressEditorHistoryShortcut("redo");
    expect((await editorDocumentText()).trimEnd()).toBe(saved.trimEnd());
  });

  it("ingests_an_external_edit_and_clears_only_the_pre_ingest_undo_log", async () => {
    await openNoteFromTree(DESKTOP_EXTERNAL_NOTE_NAME);
    await browser.waitUntil(
      async () =>
        (await editorDocumentText()).trimEnd() ===
        DESKTOP_EXTERNAL_NOTE_CONTENT.trimEnd(),
      {
        timeout: 15000,
        timeoutMsg: "desktop external-edit fixture did not open",
      },
    );
    await placeCursorAtLineEnd("external base");
    await $(".cm-content").addValue("local");
    const saved = `${DESKTOP_EXTERNAL_NOTE_CONTENT.trimEnd()}local\n`;
    await waitForDisk(DESKTOP_EXTERNAL_NOTE_NAME, saved);
    await waitForUndoGroupSettle();

    const external = `outside ${saved}`;
    writeFileSync(
      path.join(SCRATCH_VAULT_PATH, DESKTOP_EXTERNAL_NOTE_NAME),
      external,
    );
    await browser.waitUntil(
      async () => (await editorDocumentText()).trimEnd() === external.trimEnd(),
      {
        timeout: 10000,
        timeoutMsg: "the genuine external edit did not ingest",
      },
    );

    await placeCursorAtLineEnd(external.trimEnd());
    await $(".cm-content").addValue("post");
    const postIngest = `${external.trimEnd()}post`;
    expect((await editorDocumentText()).trimEnd()).toBe(postIngest);
    await pressEditorHistoryShortcut("undo");
    expect((await editorDocumentText()).trimEnd()).toBe(external.trimEnd());
    await pressEditorHistoryShortcut("undo");
    expect((await editorDocumentText()).trimEnd()).toBe(external.trimEnd());
    await pressEditorHistoryShortcut("redo");
    expect((await editorDocumentText()).trimEnd()).toBe(postIngest);
  });

  it("undoes_and_redoes_a_saved_edit_after_relaunch_with_recorded_selection", async () => {
    await openNoteFromQuickSwitcher(DURABLE_UNDO_NOTE_NAME);
    await browser.waitUntil(
      async () =>
        (await editorDocumentText()).trimEnd() ===
        DURABLE_UNDO_NOTE_CONTENT.trimEnd(),
      { timeout: 15000, timeoutMsg: "durable undo fixture did not open" },
    );
    await placeCursorAtLineEnd("durable base");
    const beforeSelection = await capturedHistoryState();
    await $(".cm-content").addValue(" session");
    const saved = `${DURABLE_UNDO_NOTE_CONTENT.trimEnd()} session\n`;
    await waitForDisk(DURABLE_UNDO_NOTE_NAME, saved);
    await waitForUndoGroupSettle();
    const afterSelection = await capturedHistoryState();

    await relaunchPackagedApplication();
    await openNoteFromQuickSwitcher(DURABLE_UNDO_NOTE_NAME);
    await waitForEditorDocument(
      saved,
      "saved durable undo fixture did not reopen",
    );
    await placeCursorAtLineEnd(saved.trimEnd());
    await pressEditorHistoryShortcut("undo");
    await browser.waitUntil(
      async () =>
        (await editorDocumentText()).trimEnd() ===
        DURABLE_UNDO_NOTE_CONTENT.trimEnd(),
      { timeoutMsg: "persisted undo did not restore the prior document" },
    );
    const restoredBefore = await capturedHistoryState();
    expect(restoredBefore?.anchor).toBe(beforeSelection?.anchor);
    expect(restoredBefore?.head).toBe(beforeSelection?.head);

    await pressEditorHistoryShortcut("redo");
    await browser.waitUntil(
      async () => (await editorDocumentText()).trimEnd() === saved.trimEnd(),
      { timeoutMsg: "persisted redo did not restore the saved edit" },
    );
    const restoredAfter = await capturedHistoryState();
    expect(restoredAfter?.anchor).toBe(afterSelection?.anchor);
    expect(restoredAfter?.head).toBe(afterSelection?.head);
  });

  it("persists_the_external_ingest_fence_across_relaunch", async () => {
    await openNoteFromQuickSwitcher(DURABLE_EXTERNAL_NOTE_NAME);
    await browser.waitUntil(
      async () =>
        (await editorDocumentText()).trimEnd() ===
        DURABLE_EXTERNAL_NOTE_CONTENT.trimEnd(),
      { timeout: 15000, timeoutMsg: "durable fence fixture did not open" },
    );
    await placeCursorAtLineEnd("durable external base");
    await $(".cm-content").addValue(" local");
    const local = `${DURABLE_EXTERNAL_NOTE_CONTENT.trimEnd()} local\n`;
    await waitForDisk(DURABLE_EXTERNAL_NOTE_NAME, local);
    await waitForUndoGroupSettle();

    const external = `outside ${local}`;
    writeFileSync(
      path.join(SCRATCH_VAULT_PATH, DURABLE_EXTERNAL_NOTE_NAME),
      external,
    );
    await browser.waitUntil(
      async () => (await editorDocumentText()).trimEnd() === external.trimEnd(),
      { timeoutMsg: "external durable-fence edit did not ingest" },
    );
    await placeCursorAtLineEnd(external.trimEnd());
    await $(".cm-content").addValue(" post");
    const postIngest = `${external.trimEnd()} post\n`;
    expect((await editorDocumentText()).trimEnd()).toBe(postIngest.trimEnd());
    await waitForDisk(DURABLE_EXTERNAL_NOTE_NAME, postIngest);
    await waitForUndoGroupSettle();

    await relaunchPackagedApplication();
    await openNoteFromQuickSwitcher(DURABLE_EXTERNAL_NOTE_NAME);
    await waitForEditorDocument(
      postIngest,
      "post-ingest durable fixture did not reopen",
    );
    await placeCursorAtLineEnd(postIngest.trimEnd());
    await pressEditorHistoryShortcut("undo");
    await browser.waitUntil(
      async () => (await editorDocumentText()).trimEnd() === external.trimEnd(),
      { timeoutMsg: "post-ingest durable step did not undo" },
    );
    // A second undo here has nothing left to undo past the ingest fence
    // (see clearUndoHistory in src/lib/Editor.svelte); like the first
    // undo above, its dispatch is synchronous, so the read below needs no
    // extra settle time.
    await pressEditorHistoryShortcut("undo");
    expect((await editorDocumentText()).trimEnd()).toBe(external.trimEnd());
    expect((await editorDocumentText()).trimEnd()).toContain("outside ");
    await pressEditorHistoryShortcut("redo");
    await browser.waitUntil(
      async () =>
        (await editorDocumentText()).trimEnd() === postIngest.trimEnd(),
      { timeoutMsg: "post-ingest durable step did not redo" },
    );
  });

  it("clear_edit_history_removes_the_note_journal", async () => {
    await openNoteFromQuickSwitcher(DURABLE_CLEAR_NOTE_NAME);
    await browser.waitUntil(
      async () =>
        (await editorDocumentText()).trimEnd() ===
        DURABLE_CLEAR_NOTE_CONTENT.trimEnd(),
      { timeout: 15000, timeoutMsg: "clear-history fixture did not open" },
    );
    await placeCursorAtLineEnd("durable clear base");
    await $(".cm-content").addValue(" sensitive");
    const saved = `${DURABLE_CLEAR_NOTE_CONTENT.trimEnd()} sensitive\n`;
    await waitForDisk(DURABLE_CLEAR_NOTE_NAME, saved);
    await waitForUndoGroupSettle();
    expect(editHistoryRecords(DURABLE_CLEAR_NOTE_NAME).length).toBeGreaterThan(
      0,
    );

    await browser.execute(() => {
      (
        window as Window & {
          __SKRIBEUM_E2E_CONFIRM_EDIT_HISTORY__?: boolean;
        }
      ).__SKRIBEUM_E2E_CONFIRM_EDIT_HISTORY__ = true;
    });
    await browser.keys([modifierKey, "p"]);
    await overlayInput();
    await browser.keys("clear edit history");
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      () => editHistoryRecords(DURABLE_CLEAR_NOTE_NAME).length === 0,
      { timeoutMsg: "clear-history command did not remove the note journal" },
    );

    await relaunchPackagedApplication();
    await openNoteFromQuickSwitcher(DURABLE_CLEAR_NOTE_NAME);
    await waitForEditorDocument(
      saved,
      "cleared durable fixture did not reopen",
    );
    await placeCursorAtLineEnd(saved.trimEnd());
    // The cleared journal leaves nothing to undo; the dispatch is
    // synchronous (see the fence undo above), so no settle time is needed
    // before confirming the document did not change.
    await pressEditorHistoryShortcut("undo");
    expect((await editorDocumentText()).trimEnd()).toBe(saved.trimEnd());
  });

  // The application dialog surface. These stay flat `it`s rather than a
  // nested `describe`, deliberately: Mocha runs every flat test in a suite
  // before any of that suite's nested suites, regardless of source order,
  // so a nested `describe` here would run after the browser-demo tests
  // below despite being declared first. The browser-demo tests navigate the
  // shared window away to the demo's own URL and never navigate back, so a
  // relaunch that ran after them would reconnect to that stranded page
  // instead of the packaged desktop app. Flat tests preserve normal
  // declaration-order execution, which keeps this trio right after the
  // last packaged-app spec, before the window is ever redirected there.
  {
    async function installNativeDialogSpies(): Promise<void> {
      await browser.execute(() => {
        const flagged = window as Window & {
          __SKRIBEUM_E2E_PROMPT_CALLS__?: number;
          __SKRIBEUM_E2E_CONFIRM_CALLS__?: number;
        };
        flagged.__SKRIBEUM_E2E_PROMPT_CALLS__ = 0;
        flagged.__SKRIBEUM_E2E_CONFIRM_CALLS__ = 0;
        window.prompt = () => {
          flagged.__SKRIBEUM_E2E_PROMPT_CALLS__ =
            (flagged.__SKRIBEUM_E2E_PROMPT_CALLS__ ?? 0) + 1;
          return null;
        };
        window.confirm = () => {
          flagged.__SKRIBEUM_E2E_CONFIRM_CALLS__ =
            (flagged.__SKRIBEUM_E2E_CONFIRM_CALLS__ ?? 0) + 1;
          return false;
        };
      });
    }

    async function nativeDialogCallCounts(): Promise<{
      prompt: number;
      confirm: number;
    }> {
      return browser.execute(() => {
        const flagged = window as Window & {
          __SKRIBEUM_E2E_PROMPT_CALLS__?: number;
          __SKRIBEUM_E2E_CONFIRM_CALLS__?: number;
        };
        return {
          prompt: flagged.__SKRIBEUM_E2E_PROMPT_CALLS__ ?? 0,
          confirm: flagged.__SKRIBEUM_E2E_CONFIRM_CALLS__ ?? 0,
        };
      });
    }

    async function openRowMenu(path: string) {
      const row = $(`[role="treeitem"][data-path="${path}"]`);
      if (!(await row.isExisting())) {
        // The tree virtualizes rows outside its rendered window; a fixture
        // late in the sort order can sit off whatever scroll position a
        // prior test left behind. Scrolling the tree to its bottom brings
        // the alphabetically-late fixture into the rendered window, without
        // routing through another surface (the quick switcher) that adds its
        // own timing to wait on.
        const tree = $('[role="tree"]');
        await tree.waitForExist({ timeout: 15000 });
        await browser.execute(
          (element) => {
            const list = element as HTMLElement;
            list.scrollTop = list.scrollHeight;
            list.dispatchEvent(new Event("scroll"));
          },
          await tree.getElement(),
        );
        await row.waitForExist({ timeout: 15000 });
      }
      await browser.execute(
        (element) => {
          (element as HTMLElement).dispatchEvent(
            new PointerEvent("pointerenter", { bubbles: false, pointerId: 31 }),
          );
        },
        await row.getElement(),
      );
      const actions = row.$(".skr-tree-actions");
      await actions.waitForDisplayed({ timeout: 10000 });
      await browser.execute(
        (element) => (element as HTMLButtonElement).click(),
        await actions.getElement(),
      );
      const menu = $(".skr-tree-menu");
      await menu.waitForDisplayed({ timeout: 10000 });
      return menu;
    }

    it("rename_refuses_a_missing_note_extension_through_the_product_dialog", async () => {
      // A relaunch, the same reset the undo/redo and external-ingest specs
      // above already rely on, so the row interactions below start from a
      // known-clean desktop tree rather than whatever scroll position or
      // dialog state the immediately preceding spec left on screen.
      await relaunchPackagedApplication();
      await installNativeDialogSpies();
      const menu = await openRowMenu(DIALOG_RENAME_NOTE_NAME);
      await menu.$('[data-command-id="tree.entry.rename"]').click();

      const dialog = $('[data-testid="dialog"]');
      await dialog.waitForDisplayed({ timeout: 10000 });
      expect(await dialog.getAttribute("role")).toBe("dialog");
      expect(await dialog.getAttribute("aria-modal")).toBe("true");
      await waitForSurfaceEntrance('[data-testid="dialog"]');

      const input = dialog.$('[data-testid="dialog-input"]');
      await input.waitForDisplayed({ timeout: 10000 });
      await input.clearValue();
      await input.setValue("zzzz-dialog-renamed-without-extension");
      await dialog.$('[data-testid="dialog-confirm"]').click();

      const error = dialog.$('[data-testid="dialog-error"]');
      await error.waitForDisplayed({ timeout: 10000 });
      expect(await error.getText()).toContain(".md");
      // Refused inline, not applied: the dialog stays open and the original
      // note is still a selectable tree entry under its original name.
      expect(await dialog.isDisplayed()).toBe(true);
      expect(
        await $(
          `[role="treeitem"][data-path="${DIALOG_RENAME_NOTE_NAME}"]`,
        ).isExisting(),
      ).toBe(true);

      await input.clearValue();
      await input.setValue("zzzz-dialog-renamed.md");
      await dialog.$('[data-testid="dialog-confirm"]').click();
      await dialog.waitForExist({ reverse: true, timeout: 10000 });

      const renamed = $(
        '[role="treeitem"][data-path="zzzz-dialog-renamed.md"]',
      );
      await renamed.waitForExist({ timeout: 10000 });
      await renamed.click();
      await browser.waitUntil(
        async () => (await currentNotePath()) === "zzzz-dialog-renamed.md",
        {
          timeout: 10000,
          timeoutMsg: "renamed note did not become selectable",
        },
      );

      expect((await nativeDialogCallCounts()).prompt).toBe(0);
    });

    it("delete_uses_the_product_confirm_dialog_with_the_destructive_role", async () => {
      await installNativeDialogSpies();
      const menu = await openRowMenu(DIALOG_DELETE_NOTE_NAME);
      await menu.$('[data-command-id="tree.entry.delete"]').click();

      const dialog = $('[data-testid="dialog"]');
      await dialog.waitForDisplayed({ timeout: 10000 });
      await waitForSurfaceEntrance('[data-testid="dialog"]');
      const confirm = dialog.$('[data-testid="dialog-confirm"]');
      expect(await confirm.getAttribute("data-btn-role")).toBe("destructive");
      expect((await dialog.$$('[data-btn-role="primary"]')).length).toBe(0);

      await confirm.click();
      await dialog.waitForExist({ reverse: true, timeout: 10000 });
      await $(
        `[role="treeitem"][data-path="${DIALOG_DELETE_NOTE_NAME}"]`,
      ).waitForExist({ reverse: true, timeout: 10000 });

      expect((await nativeDialogCallCounts()).confirm).toBe(0);
    });

    it("dialog_cancel_leaves_its_action_unapplied", async () => {
      // A single-mount, low-fixture check that Cancel is inert: reopening
      // the rename dialog on the already-renamed fixture and cancelling it
      // leaves the tree entry exactly where it was.
      const renamedPath = "zzzz-dialog-renamed.md";
      const menu = await openRowMenu(renamedPath);
      await menu.$('[data-command-id="tree.entry.rename"]').click();

      const dialog = $('[data-testid="dialog"]');
      await dialog.waitForDisplayed({ timeout: 10000 });
      await waitForSurfaceEntrance('[data-testid="dialog"]');
      const input = dialog.$('[data-testid="dialog-input"]');
      await input.clearValue();
      await input.setValue("zzzz-dialog-cancelled-name.md");
      await dialog.$('[data-testid="dialog-cancel"]').click();
      await dialog.waitForExist({ reverse: true, timeout: 10000 });

      expect(
        await $(`[role="treeitem"][data-path="${renamedPath}"]`).isExisting(),
      ).toBe(true);
      expect(
        await $(
          '[role="treeitem"][data-path="zzzz-dialog-cancelled-name.md"]',
        ).isExisting(),
      ).toBe(false);
    });
  }

  // The M3a surfaces. These run after the shell suite, so the scratch
  // vault no longer contains the removed note; the specs below use the
  // CRLF and live-preview notes exclusively.

  it("browser_demo_restores_default_appearance_and_persists", async () => {
    await openBrowserDemo(browserDemoUrl());
    await browser.execute(() => {
      localStorage.removeItem("skribeum.demo.settings");
    });
    await openBrowserDemo(browserDemoUrl());

    const editor = $(".cm-content");
    await editor.waitForDisplayed({ timeout: 15000 });
    await editor.click();
    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    await selectSettingsChoice(
      '[data-testid="settings-palette-graphite"]',
      "Graphite palette",
    );
    await waitForPersistedDemoSetting("theme", "dark");
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
            document.documentElement.dataset.darkPalette === "nightroom" &&
            document.documentElement.dataset.proseFont === "serif" &&
            persisted.theme === "system" &&
            persisted.light_palette === "manuscript" &&
            persisted.dark_palette === "nightroom" &&
            persisted.prose_font === "serif"
          );
        }),
      { timeout: 10000, timeoutMsg: "browser settings did not restore" },
    );
  });

  it("browser_demo_claims_mod_f_before_the_editor_has_focus", async () => {
    await openBrowserDemo(browserDemoUrl());

    // Focus lands outside the editor, matching a visitor who opens the
    // demo and immediately reaches for find without clicking into the
    // note first, which is exactly when a browser owns Mod-f on any
    // editor-scoped-only binding.
    await browser.execute(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });
    expect(
      await browser.execute(
        () => document.querySelector(".cm-skr-find-panel") !== null,
      ),
    ).toBe(false);

    await browser.keys([modifierKey, "f"]);
    const findPanel = $(".cm-skr-find-panel");
    await findPanel.waitForExist({ timeout: 10000 });
    expect(await findPanel.$(".cm-skr-find-input").isDisplayed()).toBe(true);
  });

  it("browser_demo_keeps_tag_completion_keys_after_autosave_refresh", async () => {
    await verifyTagCompletionAcceptance(demoTagCompletionHarness);
    await verifyTagCompletionArrowSelection(demoTagCompletionHarness);
    await verifyTagCompletionEscape(demoTagCompletionHarness);
  });

  it("browser_demo_renders_embed_skeletons_and_resolved_content", async () => {
    const fixtureUrl = new URL(browserDemoUrl());
    fixtureUrl.searchParams.set("embed-start", Date.now().toString());
    await openBrowserDemo(fixtureUrl);
    await browser.execute(() => {
      type GateWindow = Window & {
        __SKRIBEUM_E2E_NOTE_GATES__?: Record<string, Promise<void>>;
        __SKRIBEUM_E2E_NOTE_RELEASES__?: Record<string, () => void>;
      };
      const target = window as GateWindow;
      const paths = [
        "Examples/Work/decision-log.md",
        "Examples/Personal/garden-log.md",
      ];
      const gates: Record<string, Promise<void>> = {};
      const releases: Record<string, () => void> = {};
      target.__SKRIBEUM_E2E_NOTE_GATES__ = gates;
      target.__SKRIBEUM_E2E_NOTE_RELEASES__ = releases;
      for (const path of paths) {
        gates[path] = new Promise((resolve) => {
          releases[path] = resolve;
        });
      }
    });
    const staleSettings = $('[data-testid="settings-view"]');
    if (await staleSettings.isExisting()) {
      await browser.keys(Key.Escape);
      await staleSettings.waitForExist({ reverse: true, timeout: 5000 });
    }
    const commandEditor = $(".cm-content");
    await commandEditor.waitForDisplayed({ timeout: 15000 });
    await commandEditor.click();
    await browser.keys([modifierKey, "k"]);
    const commandInput = await overlayInput();
    await browser.keys("embeds");
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[role="option"][data-result-kind="file"]',
            ),
          ].some((option) =>
            (option.textContent ?? "").toLocaleLowerCase().includes("embeds"),
          ),
        ),
      { timeout: 10000, timeoutMsg: "embed fixture result did not appear" },
    );
    expect(await commandInput.getValue()).toBe("embeds");
    await browser.keys(Key.Enter);
    await browser.waitUntil(
      async () =>
        new URL(await browser.getUrl()).searchParams.get("note") ===
        "Features/embeds.md",
      { timeout: 15000, timeoutMsg: "embed fixture note did not open" },
    );

    let released = false;
    try {
      const skeleton = $('.skr-loading-embed[data-loading-state="skeleton"]');
      await skeleton.waitForExist({ timeout: 10000 });
      expect(await $$(".cm-skr-embed").length).toBe(2);
      expect(await $$(".skr-loading-embed .skr-skeleton-bar").length).toBe(4);
      const motion = await browser.execute(() => {
        const bar = document.querySelector(
          ".skr-loading-embed .skr-skeleton-bar",
        );
        if (!(bar instanceof HTMLElement)) return null;
        const style = getComputedStyle(bar);
        return {
          duration: Number.parseFloat(style.animationDuration) * 1000,
          iterations: style.animationIterationCount,
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        };
      });
      expect(motion?.duration).toBe(motion?.reducedMotion ? 0 : 1200);
      if (!motion?.reducedMotion) {
        expect(motion?.iterations).toBe("infinite");
      }
      const staticMotion = await browser.execute(() => {
        document.documentElement.dataset.animations = "false";
        const bar = document.querySelector(
          ".skr-loading-embed .skr-skeleton-bar",
        );
        const animationName =
          bar instanceof HTMLElement
            ? getComputedStyle(bar).animationName
            : null;
        document.documentElement.dataset.animations = "true";
        return animationName;
      });
      expect(staticMotion).toBe("none");
      await browser.execute(() => {
        type GateWindow = Window & {
          __SKRIBEUM_E2E_NOTE_GATES__?: Record<string, Promise<void>>;
          __SKRIBEUM_E2E_NOTE_RELEASES__?: Record<string, () => void>;
        };
        const target = window as GateWindow;
        for (const release of Object.values(
          target.__SKRIBEUM_E2E_NOTE_RELEASES__ ?? {},
        )) {
          release();
        }
        delete target.__SKRIBEUM_E2E_NOTE_GATES__;
        delete target.__SKRIBEUM_E2E_NOTE_RELEASES__;
      });
      released = true;

      await browser.waitUntil(
        async () =>
          (await $$('.skr-loading-embed[data-loading-state="skeleton"]'))
            .length === 0,
        {
          timeout: 5000,
          timeoutMsg: "embedded content did not replace skeletons",
        },
      );
      const embeds = await $$(".cm-skr-embed");
      expect(await embeds[0]?.getText()).toContain(
        "Preserve a clear window-side route",
      );
      await embeds[1]?.scrollIntoView({ block: "center" });
      await browser.waitUntil(
        async () =>
          (await embeds[1]?.getText())?.includes(
            "Photograph the drainage channel after rain.",
          ) === true,
        { timeout: 5000, timeoutMsg: "section embed content did not render" },
      );
    } finally {
      if (!released) {
        await browser.execute(() => {
          type GateWindow = Window & {
            __SKRIBEUM_E2E_NOTE_GATES__?: Record<string, Promise<void>>;
            __SKRIBEUM_E2E_NOTE_RELEASES__?: Record<string, () => void>;
          };
          const target = window as GateWindow;
          for (const release of Object.values(
            target.__SKRIBEUM_E2E_NOTE_RELEASES__ ?? {},
          )) {
            release();
          }
          delete target.__SKRIBEUM_E2E_NOTE_GATES__;
          delete target.__SKRIBEUM_E2E_NOTE_RELEASES__;
        });
      }
    }
  });

  it("browser_demo_serves_scheme_aware_favicon_metadata", async () => {
    await openBrowserDemo(browserDemoUrl());
    const metadata = await browser.executeAsync<
      {
        iconType: string | null;
        svgRoot: string;
        svgStyle: string;
        svgSymbols: string[];
        themeColors: Array<{ color: string | null; media: string | null }>;
        appleSize: [number, number];
      },
      []
    >(`
const done = arguments[arguments.length - 1];
const icon = document.querySelector('link[rel="icon"]');
const apple = document.querySelector('link[rel="apple-touch-icon"]');
Promise.all([
  fetch(icon.href).then((response) => response.text()),
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
    image.onerror = reject;
    image.src = apple.href;
  }),
]).then(([source, appleSize]) => {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  done({
    iconType: icon.getAttribute('type'),
    svgRoot: parsed.documentElement.localName,
    svgStyle: parsed.querySelector('style')?.textContent ?? '',
    svgSymbols: [...parsed.querySelectorAll('symbol')].map((symbol) => symbol.id),
    themeColors: [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => ({
      color: meta.getAttribute('content'),
      media: meta.getAttribute('media'),
    })),
    appleSize,
  });
}).catch((error) => done({ error: String(error) }));
`);
    expect(metadata.iconType).toBe("image/svg+xml");
    expect(metadata.svgRoot).toBe("svg");
    expect(metadata.svgStyle).toContain("prefers-color-scheme: dark");
    expect(metadata.svgStyle).toContain("max-width: 16px");
    expect(metadata.svgStyle).toContain("#F5F2E9");
    expect(metadata.svgStyle).toContain("#1E4D3B");
    expect(metadata.svgStyle).toContain("#14251D");
    expect(metadata.svgStyle).toContain("#7FBF9E");
    expect(metadata.svgSymbols).toEqual(["lamp-full", "lamp-small"]);
    expect(metadata.themeColors).toEqual([
      { color: "#F5F2E9", media: "(prefers-color-scheme: light)" },
      { color: "#14251D", media: "(prefers-color-scheme: dark)" },
    ]);
    expect(metadata.appleSize).toEqual([180, 180]);
  });

  it("browser_demo_highlights_lazy_languages_with_palette_tokens", async () => {
    const target = new URL(browserDemoUrl());
    target.searchParams.set("note", "Features/code-blocks.md");
    await openBrowserDemo(target);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll(".cm-line")].some(
            (line) =>
              line.textContent === "fn note_title(path: &str) -> &str {",
          ),
        ),
      { timeout: 15000, timeoutMsg: "code sample note did not open" },
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const shellLine = [...document.querySelectorAll(".cm-line")].find(
            (candidate) =>
              candidate.textContent === "if [ -f package.json ]; then",
          );
          const shellTokens = [
            ...(shellLine?.querySelectorAll("span[class]") ?? []),
          ].map((span) => span.textContent);
          const otherSamples = [
            "def note_title(path: str) -> str:",
            "note:",
            "fn note_title(path: &str) -> &str {",
          ];
          return (
            shellTokens.includes("if") &&
            shellTokens.includes("then") &&
            otherSamples.every((source) => {
              const line = [...document.querySelectorAll(".cm-line")].find(
                (candidate) => candidate.textContent === source,
              );
              return [...(line?.querySelectorAll("span[class]") ?? [])].some(
                (span) =>
                  [...span.classList].some((name) => !name.startsWith("cm-")),
              );
            })
          );
        }),
      {
        timeout: 5000,
        interval: 50,
        timeoutMsg:
          "static browser demo did not apply lazy language tokens within five seconds",
      },
    );

    const measurements = await browser.execute<
      Array<{
        mode: "light" | "dark";
        language: string;
        tokens: number;
        paletteDerived: boolean;
        minimumContrast: number;
      }>,
      []
    >(String.raw`
      const samples = [
        ["sh", "if [ -f package.json ]; then"],
        ["python", "def note_title(path: str) -> str:"],
        ["yaml", "note:"],
        ["rust", "fn note_title(path: &str) -> &str {"],
      ];
      const root = document.documentElement;
      const parseColor = (color) => {
        const hex = color.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
        if (hex !== undefined) {
          return [0, 2, 4].map((index) =>
            Number.parseInt(hex.slice(index, index + 2), 16),
          );
        }
        const srgb = color
          .trim()
          .match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
        if (srgb !== null) {
          return srgb.slice(1, 4).map((channel) => Number(channel) * 255);
        }
        const values = color
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number);
        return values ?? [0, 0, 0];
      };
      const luminance = (color) =>
        parseColor(color)
          .map((channel) => channel / 255)
          .map((channel) =>
            channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4,
          )
          .reduce(
            (sum, channel, index) =>
              sum + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0),
            0,
          );
      const contrast = (left, right) => {
        const values = [luminance(left), luminance(right)].sort(
          (a, b) => b - a,
        );
        return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
      };

      return ["light", "dark"].flatMap((mode) => {
        root.dataset.theme = mode;
        const rootStyle = getComputedStyle(root);
        const colorProbe = document.createElement("span");
        document.body.append(colorProbe);
        const tokenColors = new Set(
          [
            "keyword",
            "string",
            "number",
            "comment",
            "function",
            "type",
            "property",
            "operator",
          ].map((token) => {
            colorProbe.style.color = "var(--skr-syntax-" + token + ")";
            return getComputedStyle(colorProbe).color;
          }),
        );
        colorProbe.remove();
        const background = rootStyle.getPropertyValue("--skr-code-surface");
        return samples.map(([language, source]) => {
          const line = [
            ...document.querySelectorAll(".cm-line"),
          ].find((candidate) => candidate.textContent === source);
          const spans = [
            ...(line?.querySelectorAll("span[class]") ?? []),
          ].filter((span) =>
            [...span.classList].some((name) => !name.startsWith("cm-")),
          );
          const colors = spans.map((span) => getComputedStyle(span).color);
          return {
            mode,
            language,
            tokens: spans.length,
            paletteDerived: colors.every((color) =>
              tokenColors.has(color),
            ),
            minimumContrast: Math.min(
              ...colors.map((color) => contrast(color, background)),
            ),
          };
        });
      });
    `);

    expect(measurements).toHaveLength(8);
    for (const measurement of measurements) {
      expect(measurement.tokens).toBeGreaterThan(0);
      expect(measurement.paletteDerived).toBe(true);
      expect(measurement.minimumContrast).toBeGreaterThanOrEqual(4.5);
    }
  });
});
