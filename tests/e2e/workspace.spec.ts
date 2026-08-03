import { $, $$, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  PREVIEW_SOURCE_NOTE_NAME,
  TREE_FIRST_NOTE_NAME,
  TREE_FOLDER_NAME,
  TREE_SECOND_NOTE_NAME,
} from "./scratchVault";

const modifierKey = process.platform === "darwin" ? Key.Command : Key.Ctrl;

async function openTreePath(path: string): Promise<void> {
  const row = $(`[role="treeitem"][data-path="${path}"]`);
  await row.waitForExist({ timeout: 15000 });
  await row.click();
}

async function expandTreeFolder(): Promise<void> {
  const sidebar = $(".skr-desktop-sidebar");
  const folder = sidebar.$(
    `[role="treeitem"][data-path="${TREE_FOLDER_NAME}"]`,
  );
  await folder.waitForExist({ timeout: 15000 });
  if ((await folder.getAttribute("aria-expanded")) !== "true") {
    await folder.click();
  }
  await sidebar.$(`[data-path="${TREE_FIRST_NOTE_NAME}"]`).waitForExist({
    timeout: 10000,
  });
}

async function workspaceSnapshot(): Promise<unknown> {
  return browser.execute(() => {
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith("skribeum.workspace.v1."),
    );
    return key === undefined
      ? null
      : JSON.parse(localStorage.getItem(key) ?? "null");
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

describe("file tree, previews, panels, and workspace tabs", () => {
  before(async () => {
    await browser.tauri.switchWindow("main");
    await browser.setWindowSize(1280, 800);
    await clearWorkspaceStorage();
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  after(async () => {
    await clearWorkspaceStorage();
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  it("renders the tree identity header and contextual row controls", async () => {
    const sidebar = $(".skr-desktop-sidebar");
    const header = sidebar.$(".skr-sidebar-header");
    await header.waitForDisplayed({ timeout: 15000 });
    expect((await header.getText()).length).toBeGreaterThan(0);
    const newNote = header.$('[data-command-id="note.create"]');
    await browser.execute(
      (element) => {
        (element as HTMLElement).dispatchEvent(
          new PointerEvent("pointerenter", { bubbles: false, pointerId: 23 }),
        );
      },
      await header.getElement(),
    );
    await browser.waitUntil(
      async () =>
        browser.execute(
          (element) => getComputedStyle(element as Element).opacity === "1",
          await header.$(".skr-sidebar-header-actions").getElement(),
        ),
      { timeoutMsg: "sidebar header controls did not reveal on hover" },
    );
    expect(await newNote.isDisplayed()).toBe(true);
    expect(
      await header.$('[data-command-id="panel.sidebar.toggle"]').isDisplayed(),
    ).toBe(true);
    await browser.execute(
      (element) => {
        const headerElement = element as HTMLElement;
        headerElement.dispatchEvent(
          new PointerEvent("pointerleave", { bubbles: false, pointerId: 23 }),
        );
        headerElement
          .querySelector<HTMLElement>('[data-command-id="note.create"]')
          ?.focus();
      },
      await header.getElement(),
    );
    await browser.waitUntil(
      async () =>
        browser.execute(
          (element) => getComputedStyle(element as Element).opacity === "1",
          await header.$(".skr-sidebar-header-actions").getElement(),
        ),
      { timeoutMsg: "sidebar header controls did not reveal on focus" },
    );
    const tooltip = $(".skr-command-tooltip");
    await tooltip.waitForDisplayed({ timeout: 10000 });
    expect(await tooltip.getText()).toMatch(/new note/iu);
    expect(await tooltip.getText()).toMatch(/Ctrl\+N|⌘N/u);

    await expandTreeFolder();
    const first = sidebar.$(
      `[role="treeitem"][data-path="${TREE_FIRST_NOTE_NAME}"]`,
    );
    const second = sidebar.$(
      `[role="treeitem"][data-path="${TREE_SECOND_NOTE_NAME}"]`,
    );
    expect(await first.getText()).toContain("Shared tree title");
    expect(await first.getText()).toContain("tree-one");
    expect(await second.getText()).toContain("tree-two");
    expect(await first.$(".skr-tree-note-icon").getText()).toBe("🧭");
    expect(await first.$(".skr-tree-leading svg").isExisting()).toBe(false);
    expect(
      await sidebar
        .$(`[data-path="${TREE_FOLDER_NAME}"]`)
        .$(".skr-tree-leading svg")
        .isExisting(),
    ).toBe(true);

    await browser.execute(
      (element) => {
        (element as HTMLElement).dispatchEvent(
          new PointerEvent("pointerenter", { bubbles: false, pointerId: 29 }),
        );
      },
      await first.getElement(),
    );
    const actions = first.$(".skr-tree-actions");
    await actions.waitForDisplayed({ timeout: 10000 });
    await browser.execute(
      (element) => (element as HTMLButtonElement).click(),
      await actions.getElement(),
    );
    const pointerMenu = sidebar.$(".skr-tree-menu");
    await pointerMenu.waitForDisplayed({ timeout: 10000 });
    expect(
      await pointerMenu.$('[data-command-id="tree.entry.rename"]').isExisting(),
    ).toBe(true);
    expect(
      await pointerMenu
        .$('[data-command-id="tree.note.copy-link"]')
        .isExisting(),
    ).toBe(true);
    await pointerMenu.$('[data-command-id="tree.note.copy-link"]').click();
    const copied = $('aside[role="status"]');
    await copied.waitForDisplayed({ timeout: 10000 });
    expect(await copied.getText()).toContain("Link copied");
    await copied.$("button").click();

    await browser.execute(
      (element) => (element as HTMLElement).focus(),
      await first.getElement(),
    );
    await browser.execute(
      (element) =>
        (element as HTMLElement).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "F10",
            shiftKey: true,
            bubbles: true,
          }),
        ),
      await first.getElement(),
    );
    const keyboardMenu = sidebar.$(".skr-tree-menu");
    await keyboardMenu.waitForDisplayed({ timeout: 10000 });
    expect(
      await browser.execute(
        () => document.activeElement?.getAttribute("role") === "menuitem",
      ),
    ).toBe(true);
    await browser.keys(Key.ArrowDown);
    await browser.keys(Key.ArrowDown);
    await browser.keys(Key.Enter);
    const keyboardCopied = $('aside[role="status"]');
    await keyboardCopied.waitForDisplayed({ timeout: 10000 });
    expect(await keyboardCopied.getText()).toContain("Link copied");
  });

  it("resizes, resets, collapses, and restores the sidebar per vault", async () => {
    await expandTreeFolder();
    const divider = $('[role="separator"][aria-label="Resize sidebar"]');
    await divider.waitForDisplayed({ timeout: 10000 });
    await browser.execute(
      (element) => {
        const dividerElement = element as HTMLElement;
        dividerElement.setPointerCapture = () => {};
        dividerElement.releasePointerCapture = () => {};
        dividerElement.hasPointerCapture = () => false;
        const bounds = dividerElement.getBoundingClientRect();
        dividerElement.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            clientX: bounds.left,
            pointerId: 11,
          }),
        );
        dividerElement.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: bounds.left + 800,
            pointerId: 11,
          }),
        );
        dividerElement.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            clientX: bounds.left + 800,
            pointerId: 11,
          }),
        );
      },
      await divider.getElement(),
    );
    await browser.waitUntil(
      async () => (await divider.getAttribute("aria-valuenow")) === "24",
      { timeoutMsg: "sidebar drag did not stop at the 24rem maximum" },
    );

    await $('[aria-label="More actions"]').click();
    const outlineCommand = $('[data-command-id="panel.outline.toggle"]');
    await outlineCommand.waitForDisplayed({ timeout: 10000 });
    await outlineCommand.click();
    const outlineDivider = $('[role="separator"][aria-label="Resize outline"]');
    await outlineDivider.waitForDisplayed({ timeout: 10000 });
    await browser.execute(
      (element) => {
        const dividerElement = element as HTMLElement;
        dividerElement.setPointerCapture = () => {};
        dividerElement.releasePointerCapture = () => {};
        dividerElement.hasPointerCapture = () => false;
        const bounds = dividerElement.getBoundingClientRect();
        dividerElement.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            clientX: bounds.left,
            pointerId: 12,
          }),
        );
        dividerElement.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: bounds.left - 800,
            pointerId: 12,
          }),
        );
        dividerElement.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            clientX: bounds.left - 800,
            pointerId: 12,
          }),
        );
      },
      await outlineDivider.getElement(),
    );
    await browser.waitUntil(
      async () => (await outlineDivider.getAttribute("aria-valuenow")) === "20",
      { timeoutMsg: "outline drag did not stop at the 20rem maximum" },
    );

    await browser.refresh();
    const restored = $('[role="separator"][aria-label="Resize sidebar"]');
    await restored.waitForDisplayed({ timeout: 15000 });
    expect(await restored.getAttribute("aria-valuenow")).toBe("24");
    const restoredOutline = $(
      '[role="separator"][aria-label="Resize outline"]',
    );
    await restoredOutline.waitForDisplayed({ timeout: 15000 });
    expect(await restoredOutline.getAttribute("aria-valuenow")).toBe("20");
    await $(`[data-path="${TREE_FIRST_NOTE_NAME}"]`).waitForExist({
      timeout: 10000,
    });

    await browser.execute(
      (element) => {
        (element as HTMLElement).dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true }),
        );
      },
      await restored.getElement(),
    );
    await browser.waitUntil(
      async () => (await restored.getAttribute("aria-valuenow")) === "16",
      { timeoutMsg: "sidebar divider did not reset to 16rem" },
    );
    await browser.execute(
      (element) => {
        const dividerElement = element as HTMLElement;
        dividerElement.focus();
        dividerElement.dispatchEvent(
          new KeyboardEvent("keydown", { key: "End", bubbles: true }),
        );
      },
      await restored.getElement(),
    );
    expect(await restored.getAttribute("aria-valuenow")).toBe("24");

    const openToggle = $(
      '.skr-sidebar-header [data-command-id="panel.sidebar.toggle"]',
    );
    await $(".skr-desktop-sidebar").moveTo();
    await openToggle.click();
    await $(".skr-sidebar-content").waitForDisplayed({
      reverse: true,
      timeout: 10000,
    });
    expect(await $$('[data-command-id="panel.sidebar.toggle"]')).toHaveLength(
      1,
    );
    const collapsedToggle = $(
      '.skr-header-leading [data-command-id="panel.sidebar.toggle"]',
    );
    await collapsedToggle.waitForDisplayed({ timeout: 10000 });
    await collapsedToggle.click();
    await $(".skr-sidebar-content").waitForDisplayed({ timeout: 10000 });
    expect(await $$('[data-command-id="panel.sidebar.toggle"]')).toHaveLength(
      1,
    );
  });

  it("loads link previews through the reading pipeline and preserves pointer intent", async () => {
    await browser.execute(() => {
      (
        window as Window & { __SKRIBEUM_E2E_CONTENT_DELAY_MS__?: number }
      ).__SKRIBEUM_E2E_CONTENT_DELAY_MS__ = 700;
    });
    await openTreePath(PREVIEW_SOURCE_NOTE_NAME);
    const embedContent = $(
      '.cm-skr-embed .cm-content[aria-label^="Embedded note"]',
    );
    await embedContent.waitForExist({ timeout: 15000 });
    const link = $('[data-preview-target="workspace-preview-target"]');
    await link.waitForExist({ timeout: 10000 });
    await browser.execute(
      (element) => (element as HTMLElement).focus(),
      await link.getElement(),
    );
    await browser.execute(
      (element) =>
        (element as HTMLElement).dispatchEvent(
          new PointerEvent("pointerover", { bubbles: true, pointerId: 17 }),
        ),
      await link.getElement(),
    );
    const preview = $('[data-testid="link-preview"]');
    await preview.waitForDisplayed({ timeout: 1500 });
    await preview
      .$('[data-loading-state="skeleton"]')
      .waitForExist({ timeout: 1000 });
    expect(await preview.$$(".skr-skeleton-bar")).toHaveLength(3);
    expect(
      await browser.execute(
        () =>
          !document
            .querySelector('[data-testid="link-preview"]')
            ?.contains(document.activeElement),
      ),
    ).toBe(true);
    await preview.$(".cm-content").waitForExist({ timeout: 3000 });
    expect(
      await preview.$(".cm-content").getHTML({ includeSelectorTag: false }),
    ).toBe(await embedContent.getHTML({ includeSelectorTag: false }));

    await browser.execute(() => {
      const linkElement = document.querySelector<HTMLElement>(
        '[data-preview-target="workspace-preview-target"]',
      );
      const panel = document.querySelector<HTMLElement>(
        '[data-testid="link-preview"]',
      );
      if (linkElement === null || panel === null) return;
      const linkBounds = linkElement.getBoundingClientRect();
      const panelBounds = panel.getBoundingClientRect();
      const origin = {
        x: linkBounds.right,
        y: linkBounds.top + linkBounds.height / 2,
      };
      linkElement.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          clientX: origin.x,
          clientY: origin.y,
          relatedTarget: document.body,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: (origin.x + panelBounds.left) / 2,
          clientY: (origin.y + panelBounds.top + panelBounds.bottom) / 3,
        }),
      );
      panel.dispatchEvent(
        new PointerEvent("pointerover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    await browser.pause(320);
    expect(await preview.isExisting()).toBe(true);
    await browser.keys(Key.Escape);
    await preview.waitForExist({ reverse: true, timeout: 10000 });
    await browser.execute(() => {
      delete (window as Window & { __SKRIBEUM_E2E_CONTENT_DELAY_MS__?: number })
        .__SKRIBEUM_E2E_CONTENT_DELAY_MS__;
    });
  });

  it("opens, closes, reorders, splits, and restores tabs with pane history", async () => {
    await expandTreeFolder();
    await openTreePath(TREE_FIRST_NOTE_NAME);
    await openTreePath(TREE_SECOND_NOTE_NAME);
    const tabs = await $$('[role="tab"]');
    expect(tabs.length).toBeGreaterThanOrEqual(3);

    const firstTab = tabs[0];
    const lastTab = tabs[tabs.length - 1];
    if (firstTab === undefined || lastTab === undefined) {
      throw new Error("tab fixture did not open");
    }
    const firstTabText = await firstTab.getText();
    await browser.execute(
      (source) => {
        const transfer = new DataTransfer();
        (source as HTMLElement).dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }),
        );
      },
      await firstTab.getElement(),
    );
    await browser.pause(20);
    await browser.execute(
      (target) => {
        const transfer = new DataTransfer();
        const bounds = (target as HTMLElement).getBoundingClientRect();
        (target as HTMLElement).dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            clientX: bounds.right,
            dataTransfer: transfer,
          }),
        );
      },
      await lastTab.getElement(),
    );
    await browser.pause(20);
    await browser.execute(
      (target) => {
        (target as HTMLElement).dispatchEvent(
          new DragEvent("drop", { bubbles: true }),
        );
      },
      await lastTab.getElement(),
    );
    const reordered = await $$('[role="tab"]');
    expect(await reordered[reordered.length - 1]?.getText()).toContain(
      firstTabText,
    );

    const close = $(".skr-tab-active .skr-tab-close");
    await close.click();
    const closedCount = await $$('[role="tab"]').length;
    await browser.keys([modifierKey, Key.Shift, "t"]);
    await browser.waitUntil(
      async () => (await $$('[role="tab"]').length) === closedCount + 1,
      { timeoutMsg: "closed tab did not reopen" },
    );

    await $('[aria-label="More actions"]').click();
    const splitCommand = $('[data-command-id="pane.split-right"]');
    await splitCommand.waitForDisplayed({ timeout: 10000 });
    await splitCommand.click();
    await browser.waitUntil(
      async () => (await $$(".skr-editor-pane").length) === 2,
      { timeoutMsg: "split command did not create a second pane" },
    );
    const beforeReload = (await workspaceSnapshot()) as {
      panes: Array<{ history: unknown[]; tabs: unknown[] }>;
      focusedPaneId: string;
    };
    expect(beforeReload.panes).toHaveLength(2);
    expect(beforeReload.panes.every((pane) => pane.history.length > 0)).toBe(
      true,
    );

    await browser.refresh();
    await browser.waitUntil(
      async () => (await $$(".skr-editor-pane").length) === 2,
      { timeout: 15000, timeoutMsg: "split workspace did not restore" },
    );
    const afterReload = (await workspaceSnapshot()) as typeof beforeReload;
    expect(afterReload.panes.map((pane) => pane.tabs)).toEqual(
      beforeReload.panes.map((pane) => pane.tabs),
    );
    expect(afterReload.panes.map((pane) => pane.history)).toEqual(
      beforeReload.panes.map((pane) => pane.history),
    );
    expect(afterReload.focusedPaneId).toBe(beforeReload.focusedPaneId);
  });
});
