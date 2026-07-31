import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  CRLF_NOTE_NAME,
  LF_NOTE_NAME,
  LIVE_PREVIEW_NOTE_NAME,
  SCRATCH_VAULT_PATH,
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
  await $(`.cm-line=${text}`).click();
  await browser.execute((lineText: string) => {
    const line = [...document.querySelectorAll(".cm-line")].find(
      (candidate) => candidate.textContent === lineText,
    );
    if (line === undefined) {
      throw new Error(`no editor line with text ${lineText}`);
    }
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

  it("renders_live_preview_hiding_the_heading_marker_until_cursor_enters", async () => {
    await openNoteFromTree(LIVE_PREVIEW_NOTE_NAME);
    await browser.waitUntil(
      async () => (await editorText()).includes("Sunrise heading"),
      {
        timeout: 15000,
      },
    );

    const headingLineText = () =>
      browser.execute(
        () => document.querySelector(".cm-line")?.textContent ?? "",
      );

    // A fresh note opens with the cursor at offset zero, on the heading
    // line, where cursor-line reveal shows the marker; move the cursor to
    // the body first (a synthesized click alone does not move CodeMirror's
    // selection here, hence the helper), then assert the marker hides.
    await placeCursorAtLineEnd("body text here");
    await browser.waitUntil(
      async () => (await headingLineText()) === "Sunrise heading",
      {
        timeout: 10000,
        timeoutMsg: "heading marker did not hide with the cursor elsewhere",
      },
    );

    // Entering the heading line with the cursor reveals the source
    // marker (cursor-line reveal per docs/decoration-rules.md).
    await placeCursorAtLineEnd("Sunrise heading");
    await browser.waitUntil(
      async () => (await headingLineText()) === "# Sunrise heading",
      {
        timeout: 10000,
        timeoutMsg: "heading marker did not reveal on cursor entry",
      },
    );

    // Leaving the line hides the marker again.
    await placeCursorAtLineEnd("body text here");
    await browser.waitUntil(
      async () => (await headingLineText()) === "Sunrise heading",
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
