import { mkdirSync, readFileSync, rmSync } from "node:fs";
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
  LIVE_PREVIEW_NOTE_NAME,
  RENDERING_NOTE_NAME,
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
        return visibleContent.textContent === lineText;
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

/** Sets the theme select's value and fires the change event it binds on. */
async function selectTheme(value: string) {
  await browser.execute((themeValue: string) => {
    const select = document.querySelector<HTMLSelectElement>(
      '[data-testid="settings-theme"]',
    );
    if (select === null) {
      throw new Error("settings theme select missing");
    }
    select.value = themeValue;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
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
      const calloutLine = callout?.querySelector<HTMLElement>(
        ".cm-skr-callout-body .cm-line",
      );
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
            Number.parseFloat(calloutLineStyle.paddingLeft),
          code: codeBox.left + Number.parseFloat(codeStyle.paddingLeft),
        },
        calloutTextBounds: {
          left:
            calloutLineBox.left +
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
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
        ?.focus();
    });
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
        document.querySelector('[role="treeitem"][tabindex="0"]'),
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
          maxWidth: Number.parseFloat(style.maxWidth),
          opacity: style.opacity,
          transitionDurations: style.transitionDuration
            .split(",")
            .map((duration) => Number.parseFloat(duration) * 1000),
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
    expect(hidden?.maxWidth).toBe(0);
    expect(hidden?.opacity).toBe("0");
    expect(
      hidden?.transitionDurations.every((duration) => duration < 200),
    ).toBe(true);

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
    expect(revealed?.maxWidth ?? 0).toBeGreaterThan(0);
    expect(revealed?.opacity).toBe("1");

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

  /** Reads the persisted reading measure through IPC. */
  async function persistedReadingMeasure(): Promise<number | string> {
    return browser.executeAsync<number | string, []>((done) => {
      const tauri = (
        window as unknown as {
          __TAURI__?: {
            core: {
              invoke: (
                name: string,
              ) => Promise<{ editor_reading_measure: number }>;
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
        .then((doc) => done(doc.editor_reading_measure))
        .catch((error: unknown) => done(String(error)));
    });
  }

  /** Sets the settings font size through the open dialog's input. */
  async function setFontSizeThroughDialog(value: number) {
    const fontInput = $('[data-testid="settings-font-size"]');
    await fontInput.setValue(String(value));
    // Commit the change event explicitly: the synthesized driver does
    // not move focus, which is what fires change on number inputs.
    await browser.execute(() => {
      document
        .querySelector<HTMLInputElement>('[data-testid="settings-font-size"]')
        ?.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  /** Sets the reading measure through the open dialog's input. */
  async function setReadingMeasureThroughDialog(value: number) {
    const input = $('[data-testid="settings-reading-measure"]');
    await input.setValue(String(value));
    await browser.execute(() => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="settings-reading-measure"]',
        )
        ?.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("settings_round_trip_applies_restart_free_and_persists", async () => {
    // The settings file is the real per-user document; pick a target
    // that differs from the current value and restore it afterwards.
    const original = await persistedFontSize();
    const originalMeasure = await persistedReadingMeasure();
    expect(typeof original).toBe("number");
    expect(typeof originalMeasure).toBe("number");
    const target = original === 21 ? 22 : 21;
    const targetMeasure = originalMeasure === 72 ? 78 : 72;

    await browser.keys([modifierKey, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });
    await setFontSizeThroughDialog(target);
    await setReadingMeasureThroughDialog(targetMeasure);

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
      async () => (await persistedReadingMeasure()) === targetMeasure,
      { timeout: 10000, timeoutMsg: "reading measure did not persist" },
    );

    await browser.keys([modifierKey, ","]);
    await dialog.waitForExist({ timeout: 10000 });
    expect(await $('[data-testid="settings-font-size"]').getValue()).toBe(
      String(target),
    );
    expect(await $('[data-testid="settings-reading-measure"]').getValue()).toBe(
      String(targetMeasure),
    );

    // Restore the pre-test value through the same UI path.
    await setFontSizeThroughDialog(original as number);
    await setReadingMeasureThroughDialog(originalMeasure as number);
    await browser.waitUntil(
      async () => (await persistedFontSize()) === original,
      { timeout: 10000 },
    );
    await browser.waitUntil(
      async () => (await persistedReadingMeasure()) === originalMeasure,
      { timeout: 10000 },
    );
    await browser.keys(Key.Escape);
    await browser.waitUntil(
      async () => !(await $('[data-testid="settings-view"]').isExisting()),
      { timeout: 5000 },
    );
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

  it("keyboard_traversal_covers_the_new_surfaces_without_traps", async () => {
    await closeAnyOverlay();

    // The palette input leaves Tab uncanceled (no keyboard trap) and
    // Escape returns focus to the editor.
    await browser.keys([modifierKey, "p"]);
    await overlayInput();
    const tabUncanceled = await browser.execute(() => {
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
      return !event.defaultPrevented;
    });
    expect(tabUncanceled).toBe(true);
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
    const select = $('[data-testid="settings-theme"]');
    const original = await select.getValue();

    // The embedded provider cannot drive native select interaction; set the
    // value and dispatch the change event, which still exercises the real
    // binding, store, and theme application path.
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
