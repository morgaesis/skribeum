import { $, $$, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  CONFIG_FILE_NAME,
  PREVIEW_SOURCE_NOTE_NAME,
  TREE_FIRST_NOTE_NAME,
  TREE_FOLDER_NAME,
  TREE_SECOND_NOTE_NAME,
} from "./scratchVault";
import { settled } from "./settle";

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
      candidate.startsWith("skribeum.workspace."),
    );
    return key === undefined
      ? null
      : JSON.parse(localStorage.getItem(key) ?? "null");
  });
}

/** Counts the leaves of a persisted pane tree. */
function paneCountOf(node: unknown): number {
  if (typeof node !== "object" || node === null) return 0;
  const candidate = node as { type?: string; children?: unknown[] };
  if (candidate.type !== "split") return 1;
  return (candidate.children ?? []).reduce<number>(
    (total, child) => total + paneCountOf(child),
    0,
  );
}

function tabPathsOf(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  const candidate = node as {
    type?: string;
    tabs?: Array<{ path?: string }>;
    children?: unknown[];
  };
  if (candidate.type !== "split") {
    return (candidate.tabs ?? [])
      .map((tab) => tab.path)
      .filter((path): path is string => typeof path === "string");
  }
  return (candidate.children ?? []).flatMap(tabPathsOf);
}

function activePathsNameTabs(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as {
    type?: string;
    activePath?: string | null;
    tabs?: Array<{ path?: string }>;
    children?: unknown[];
  };
  if (candidate.type === "split") {
    return (
      candidate.children?.length === 2 &&
      candidate.children.every(activePathsNameTabs)
    );
  }
  return (
    candidate.activePath === null ||
    (typeof candidate.activePath === "string" &&
      (candidate.tabs ?? []).some((tab) => tab.path === candidate.activePath))
  );
}

async function clearWorkspaceStorage(): Promise<void> {
  await browser.execute(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("skribeum.workspace.")) localStorage.removeItem(key);
    }
  });
}

/** Sends the tree-row drag payload through a pane's drop handlers. */
async function dragTreePathToPane(
  path: string,
  paneIndex: number,
  zone: "center" | "left" | "up",
): Promise<void> {
  await browser.execute(
    (
      treePath: string,
      targetIndex: number,
      dropZone: "center" | "left" | "up",
    ) => {
      const source = document.querySelector<HTMLElement>(
        `[role="treeitem"][data-path="${CSS.escape(treePath)}"]`,
      );
      const target = [
        ...document.querySelectorAll<HTMLElement>("[data-pane-id]"),
      ][targetIndex];
      if (source === null || target === undefined) {
        throw new Error("tree-row pane-drop fixture is not rendered");
      }
      const transfer = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      const bounds = target.getBoundingClientRect();
      const clientX =
        dropZone === "center" || dropZone === "up"
          ? bounds.left + bounds.width / 2
          : bounds.left + bounds.width * 0.1;
      const clientY =
        dropZone === "up"
          ? bounds.top + bounds.height * 0.1
          : bounds.top + bounds.height / 2;
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer: transfer,
        }),
      );
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer: transfer,
        }),
      );
      source.dispatchEvent(
        new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }),
      );
    },
    path,
    paneIndex,
    zone,
  );
}

type PaneSnapshot = {
  id: string;
  activePath: string | null;
  focused: boolean;
  tabs: string[];
};

async function paneSnapshots(): Promise<PaneSnapshot[]> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-pane-id]")].map(
      (pane) => ({
        id: pane.dataset.paneId ?? "",
        activePath:
          pane
            .querySelector<HTMLElement>("[data-testid='reading-surface']")
            ?.getAttribute("data-note-path") ?? null,
        focused: pane.classList.contains("skr-editor-pane-focused"),
        tabs: [...pane.querySelectorAll<HTMLElement>("[data-tab-key]")]
          .map((tab) => tab.dataset.tabKey ?? "")
          .filter((path) => path.length > 0),
      }),
    ),
  );
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
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(".skr-sidebar-header")
        ?.dispatchEvent(
          new PointerEvent("pointerleave", { bubbles: false, pointerId: 23 }),
        );
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !document
              .querySelector(".skr-desktop-sidebar")
              ?.classList.contains("skr-sidebar-header-hovered"),
        ),
      { timeoutMsg: "sidebar header hover state did not clear" },
    );
    const treeFocusTarget = $(
      `[role="treeitem"][data-path="${TREE_FOLDER_NAME}"]`,
    );
    await treeFocusTarget.waitForDisplayed({ timeout: 10000 });
    await browser.execute((path: string) => {
      document
        .querySelector<HTMLElement>(
          `[role="treeitem"][data-path="${CSS.escape(path)}"]`,
        )
        ?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    }, TREE_FOLDER_NAME);
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const actions = document.querySelector(".skr-sidebar-header-actions");
          return (
            document
              .querySelector(".skr-desktop-sidebar")
              ?.classList.contains("skr-sidebar-focused") === true &&
            actions !== null &&
            getComputedStyle(actions).opacity === "1"
          );
        }),
      { timeoutMsg: "sidebar header controls did not reveal on focus" },
    );
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(
          '.skr-sidebar-header [data-command-id="note.create"]',
        )
        ?.dispatchEvent(
          new PointerEvent("pointerenter", {
            bubbles: false,
            pointerId: 24,
          }),
        );
    });
    const tooltip = $(".skr-command-tooltip");
    await tooltip.waitForDisplayed({ timeout: 10000 });
    expect(await tooltip.getText()).toMatch(/new note/iu);
    expect(await tooltip.getText()).toMatch(/Ctrl\+N|⌘N/u);
    await browser.execute((path: string) => {
      document
        .querySelector<HTMLElement>(
          `[role="treeitem"][data-path="${CSS.escape(path)}"]`,
        )
        ?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }, TREE_FOLDER_NAME);
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !document
              .querySelector(".skr-desktop-sidebar")
              ?.classList.contains("skr-sidebar-focused"),
        ),
      { timeoutMsg: "sidebar header focus state did not clear" },
    );

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
    // Wide viewports announce in the statusline's center slot (section
    // 6.2); the banner strip is the narrow-viewport route.
    const copied = $(
      '[data-testid="statusline-announcements"] .skr-statusline-announcement',
    );
    await copied.waitForDisplayed({ timeout: 10000 });
    expect(await copied.getText()).toContain("Link copied");
    await copied.waitForExist({ reverse: true, timeout: 10000 });

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
    await browser.keys(Key.ArrowDown);
    await browser.keys(Key.Enter);
    const keyboardCopied = $(
      '[data-testid="statusline-announcements"] .skr-statusline-announcement',
    );
    await keyboardCopied.waitForDisplayed({ timeout: 10000 });
    expect(await keyboardCopied.getText()).toContain("Link copied");
  });

  it("keeps the tab strip visible on narrow viewports", async () => {
    await openTreePath(TREE_FIRST_NOTE_NAME);
    await browser.setWindowSize(600, 800);

    const strip = $(".skr-tab-strip");
    await strip.waitForDisplayed({ timeout: 10000 });
    expect(await strip.getCSSProperty("display")).toMatchObject({
      value: "flex",
    });
    expect(await strip.$$('[role="tab"]')).toHaveLength(1);

    await browser.setWindowSize(1280, 800);
    await $("[role=tree]").waitForDisplayed({ timeout: 10000 });
  });

  it("keeps one vault picker open while source mode toggles", async () => {
    const vaultControl = $('button[aria-label="Vaults"]');
    await vaultControl.waitForDisplayed({ timeout: 10000 });
    await vaultControl.click();
    await browser.waitUntil(
      async () => (await $$('[data-testid="anchored-menu"]')).length === 1,
      { timeoutMsg: "vault picker did not open" },
    );
    expect(await $$('[data-vault-picker-active="true"]')).toHaveLength(1);
    await vaultControl.click();
    await browser.waitUntil(
      async () => (await $$('[data-testid="anchored-menu"]')).length === 0,
      { timeoutMsg: "vault picker did not close on a second activation" },
    );

    await openTreePath(TREE_FIRST_NOTE_NAME);
    await $('[aria-label="More actions"]').click();
    const sourceToggle = $('[data-command-id="editor.toggle-source-mode"]');
    await sourceToggle.waitForDisplayed({ timeout: 10000 });
    await sourceToggle.click();
    expect(await $$('[data-testid="anchored-menu"]')).toHaveLength(1);
    const trailing = sourceToggle.$(".skr-action-menu-trailing");
    expect(await trailing.$(".skr-action-menu-check").getText()).toBe("✓");
    expect(
      await browser.execute(
        (element) =>
          (element as HTMLElement).lastElementChild?.classList.contains(
            "skr-action-menu-trailing",
          ) ?? false,
        await sourceToggle.getElement(),
      ),
    ).toBe(true);
    await browser.keys(Key.Escape);
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
    const restoredDividerValues = await browser.waitUntil(
      () =>
        browser.execute(() => {
          const sidebarSeparator = document.querySelector<HTMLElement>(
            '[role="separator"][aria-label="Resize sidebar"]',
          );
          const outlineSeparator = document.querySelector<HTMLElement>(
            '[role="separator"][aria-label="Resize outline"]',
          );
          const sidebar =
            sidebarSeparator !== null &&
            getComputedStyle(sidebarSeparator).display !== "none"
              ? sidebarSeparator.getAttribute("aria-valuenow")
              : null;
          const outline =
            outlineSeparator !== null &&
            getComputedStyle(outlineSeparator).display !== "none"
              ? outlineSeparator.getAttribute("aria-valuenow")
              : null;
          return sidebar === "24" && outline === "20"
            ? { sidebar, outline }
            : null;
        }),
      {
        // A refresh reloads the whole webview: vault reconnect, settings
        // restore, and tree rebuild all have to land before these values
        // read as restored, and under CPU contention that chain runs far
        // slower than its steady-state latency.
        timeout: 30000,
        timeoutMsg: "panel divider values did not restore after reload",
      },
    );
    expect(restoredDividerValues).toEqual({ sidebar: "24", outline: "20" });
    // The tree can still be mid-rebuild immediately after the divider
    // values restore (both read from the same reload, but the tree waits
    // on the vault re-open round trip); give it a more generous budget
    // than a settled-state check needs.
    await $(`[data-path="${TREE_FIRST_NOTE_NAME}"]`).waitForExist({
      timeout: 45000,
    });
    const restored = $('[role="separator"][aria-label="Resize sidebar"]');

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
    // Poll like the dblclick reset above rather than reading once: both
    // route through the same synchronous PanelDivider onResize callback,
    // so both should observe the new value on the same terms.
    await browser.waitUntil(
      async () => (await restored.getAttribute("aria-valuenow")) === "24",
      { timeoutMsg: "sidebar divider did not extend to the 24rem maximum" },
    );

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

  it("keeps focus on the sidebar restore toggle across keyboard collapse", async () => {
    await clearWorkspaceStorage();
    await browser.setWindowSize(1280, 800);
    await browser.refresh();
    await $(`[role=tree]`).waitForExist({ timeout: 15000 });

    const divider = $('[role="separator"][aria-label="Resize sidebar"]');
    await divider.waitForDisplayed({ timeout: 10000 });
    await browser.execute(
      (element) => {
        const control = element as HTMLElement;
        control.focus();
        control.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      },
      await divider.getElement(),
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const panel = document.querySelector<HTMLElement>(
            ".skr-desktop-sidebar",
          );
          const restore = document.querySelector<HTMLElement>(
            '.skr-header-leading [data-command-id="panel.sidebar.toggle"][aria-label="Expand sidebar"]',
          );
          return (
            panel?.style.width === "0rem" &&
            panel.querySelector('[role="separator"]') === null &&
            panel.querySelector(".skr-sidebar-content") === null &&
            restore !== null &&
            document.activeElement === restore &&
            document.activeElement !== document.body
          );
        }),
      {
        timeoutMsg:
          "focused sidebar separator did not transfer focus to the restore toggle",
      },
    );

    await $('[aria-label="Expand sidebar"]').click();
    await $(".skr-sidebar-content").waitForDisplayed({ timeout: 10000 });
    const collapseButton = $(
      '.skr-sidebar-header [data-command-id="panel.sidebar.toggle"]',
    );
    await collapseButton.waitForDisplayed({ timeout: 10000 });
    await browser.execute(
      (element) => {
        const control = element as HTMLElement;
        control.focus();
        control.click();
      },
      await collapseButton.getElement(),
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const restore = document.querySelector<HTMLElement>(
            '.skr-header-leading [data-command-id="panel.sidebar.toggle"][aria-label="Expand sidebar"]',
          );
          return restore !== null && document.activeElement === restore;
        }),
      {
        timeoutMsg:
          "focused in-panel collapse button did not transfer focus to the restore toggle",
      },
    );

    await $('[aria-label="Expand sidebar"]').click();
    await $(".skr-sidebar-content").waitForDisplayed({ timeout: 10000 });
    const readingSurface = $('[data-testid="reading-surface"]');
    await readingSurface.waitForExist({ timeout: 10000 });
    const readingSurfaceElement = await readingSurface.getElement();
    await browser.execute(
      (element) => (element as HTMLElement).focus(),
      readingSurfaceElement,
    );
    const pointerCollapseButton = $(
      '.skr-sidebar-header [data-command-id="panel.sidebar.toggle"]',
    );
    await browser.execute(
      (element) => {
        const control = element as HTMLElement;
        control.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            pointerId: 31,
          }),
        );
        control.dispatchEvent(
          new MouseEvent("click", { bubbles: true, button: 0 }),
        );
      },
      await pointerCollapseButton.getElement(),
    );
    await browser.waitUntil(
      () =>
        browser.execute((element) => {
          const panel = document.querySelector<HTMLElement>(
            ".skr-desktop-sidebar",
          );
          return (
            panel?.style.width === "0rem" && document.activeElement === element
          );
        }, readingSurfaceElement),
      {
        timeoutMsg:
          "pointer collapse changed focus when focus was outside the sidebar",
      },
    );

    await $('[aria-label="Expand sidebar"]').click();
    await $(".skr-sidebar-content").waitForDisplayed({ timeout: 10000 });
  });

  it("returns focus to surviving More actions after Settings closes", async () => {
    const opener = $('button[aria-label="More actions"]');
    await opener.waitForDisplayed({ timeout: 10000 });
    await opener.click();

    const menu = $('[data-testid="anchored-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    const settingsCommand = menu.$('[data-command-id="settings.open"]');
    await settingsCommand.waitForDisplayed({ timeout: 10000 });
    await settingsCommand.click();

    const settings = $('[data-testid="settings-view"]');
    await settings.waitForDisplayed({ timeout: 10000 });
    await browser.keys(Key.Escape);
    await settings.waitForExist({ reverse: true, timeout: 5000 });

    await browser.execute(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    const focusEvidence = await browser.execute(() => {
      const active = document.activeElement;
      const survivingOpener = document.querySelector<HTMLButtonElement>(
        'button[aria-label="More actions"]',
      );
      return {
        activeIsOpener: active === survivingOpener,
        activeIsBody: active === document.body,
        activeInsideSettings:
          active?.closest('[data-testid="settings-view"]') !== null,
        openerConnected: survivingOpener?.isConnected === true,
      };
    });
    expect(focusEvidence).toEqual({
      activeIsOpener: true,
      activeIsBody: false,
      activeInsideSettings: false,
      openerConnected: true,
    });
  });

  it("loads link previews through the reading pipeline and preserves pointer intent", async () => {
    await browser.execute(() => {
      (
        window as Window & { __SKRIBEUM_E2E_CONTENT_DELAY_MS__?: number }
        // The skeleton is only observable while the content is still
        // arriving, so this delay is the width of the window the assertions
        // below have to land in. Every check spends a driver round trip, and
        // on a loaded machine a few of those together outlast a window of a
        // few hundred milliseconds, which reads as a skeleton that rendered
        // nothing rather than one that had already been replaced.
      ).__SKRIBEUM_E2E_CONTENT_DELAY_MS__ = 2500;
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
    // Asked in one round trip rather than three: the skeleton's presence and
    // the count of its bars are the same fact about the same moment, and
    // asking separately lets the loading state end between the questions.
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const host = document.querySelector('[data-testid="link-preview"]');
          if (host?.querySelector('[data-loading-state="skeleton"]') == null) {
            return -1;
          }
          return host.querySelectorAll(".skr-skeleton-bar").length;
        })) === 3,
      {
        timeout: 10000,
        timeoutMsg: "the loading preview never showed three skeleton bars",
      },
    );
    expect(
      await browser.execute(
        () =>
          !document
            .querySelector('[data-testid="link-preview"]')
            ?.contains(document.activeElement),
      ),
    ).toBe(true);
    // Outlasts the deliberate content delay above with room for a loaded
    // machine, since the editor only mounts once the content has arrived.
    await preview.$(".cm-content").waitForExist({ timeout: 15000 });
    // The preview's editor mounts with the note's source text and replaces it
    // with decorations a pass later, so its markup is compared once it stops
    // changing. Sampling on arrival compares the raw markdown against the
    // decorated original and reports a rendering fault that does not exist.
    expect(
      await settled(() =>
        preview.$(".cm-content").getHTML({ includeSelectorTag: false }),
      ),
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
    // Proving the pointer-travel cone keeps the preview open needs a real
    // wait past its own keepConeAlive timer (300ms, in
    // src/lib/editor/decorations/engine.ts) to confirm the panel was not
    // dismissed, rather than a condition to poll for.
    await browser.pause(320);
    expect(await preview.isExisting()).toBe(true);
    await browser.keys(Key.Escape);
    await preview.waitForExist({ reverse: true, timeout: 10000 });
    await browser.execute(() => {
      delete (window as Window & { __SKRIBEUM_E2E_CONTENT_DELAY_MS__?: number })
        .__SKRIBEUM_E2E_CONTENT_DELAY_MS__;
    });
  });

  it("reuses the active tab for tree opens and adds one only on demand", async () => {
    await expandTreeFolder();
    await openTreePath(TREE_FIRST_NOTE_NAME);
    // Open in place is the default: a second tree open replaces the active
    // tab while the strip remains available for its single tab.
    await openTreePath(TREE_SECOND_NOTE_NAME);
    await browser.waitUntil(
      async () => (await $$('[role="tab"]').length) === 1,
      {
        timeoutMsg: "a plain tree open did not retain one active tab",
      },
    );

    // Mod-click is one of the explicit new-tab routes.
    await browser.execute(
      (element) => {
        (element as HTMLElement).dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            ctrlKey: true,
            metaKey: true,
          }),
        );
      },
      await $(
        `[role="treeitem"][data-path="${TREE_FIRST_NOTE_NAME}"]`,
      ).getElement(),
    );
    await browser.waitUntil(
      async () => (await $$('[role="tab"]').length) === 2,
      {
        timeoutMsg: "mod-click did not open a second tab",
      },
    );

    const configRow = await $(
      `[role="treeitem"][data-path="${CONFIG_FILE_NAME}"]`,
    ).getElement();
    await browser.execute((element) => {
      (element as HTMLElement).dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
    }, configRow);
    await browser.waitUntil(
      async () => (await $$('[role="tab"]').length) === 3,
      { timeoutMsg: "middle-click did not open a third tab" },
    );

    const previewRow = await $(
      `[role="treeitem"][data-path="${PREVIEW_SOURCE_NOTE_NAME}"]`,
    ).getElement();
    await browser.execute((element) => {
      const row = element as HTMLElement;
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, previewRow);
    await browser.waitUntil(
      async () => (await $$('[role="tab"]').length) === 4,
      { timeoutMsg: "double-click did not preserve the displaced tab" },
    );
    const snapshot = (await workspaceSnapshot()) as { layout: unknown };
    expect(tabPathsOf(snapshot.layout)).toEqual([
      TREE_SECOND_NOTE_NAME,
      TREE_FIRST_NOTE_NAME,
      CONFIG_FILE_NAME,
      PREVIEW_SOURCE_NOTE_NAME,
    ]);
  });

  it("keeps an accepted missing-note navigation backed by an active tab", async () => {
    const missingPath = "removed-before-navigation.md";
    await browser.execute(async (path) => {
      await (
        window as Window & {
          __SKRIBEUM_E2E_OPEN_NOTE__?: (target: string) => Promise<void>;
        }
      ).__SKRIBEUM_E2E_OPEN_NOTE__?.(path);
    }, missingPath);
    await $('[data-testid="note-not-found"]').waitForDisplayed({
      timeout: 10000,
    });

    let snapshot: { layout: unknown } | null = null;
    await browser.waitUntil(
      async () => {
        snapshot = (await workspaceSnapshot()) as typeof snapshot;
        return (
          snapshot !== null &&
          tabPathsOf(snapshot.layout).includes(missingPath) &&
          activePathsNameTabs(snapshot.layout)
        );
      },
      {
        timeoutMsg:
          "missing-note navigation did not persist an active tab invariant",
      },
    );
    expect(snapshot).not.toBeNull();

    await openTreePath(TREE_FIRST_NOTE_NAME);
  });

  it("routes tree-row drops to pane centers and edges", async () => {
    await clearWorkspaceStorage();
    await browser.refresh();
    await $(`[role="treeitem"][data-path="${TREE_FOLDER_NAME}"]`).waitForExist({
      timeout: 15000,
    });
    await expandTreeFolder();
    await openTreePath(TREE_FIRST_NOTE_NAME);

    await dragTreePathToPane(TREE_SECOND_NOTE_NAME, 0, "center");
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          document
            .querySelector("[data-testid='reading-surface']")
            ?.getAttribute("data-note-path"),
        )) === TREE_SECOND_NOTE_NAME,
      { timeoutMsg: "center tree drop did not open its file in the pane" },
    );
    expect(await $$(".skr-editor-pane")).toHaveLength(1);

    await dragTreePathToPane(PREVIEW_SOURCE_NOTE_NAME, 0, "left");
    await browser.waitUntil(
      async () => (await $$(".skr-editor-pane")).length === 2,
      { timeoutMsg: "edge tree drop did not create a second pane" },
    );
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          document
            .querySelector("[data-testid='reading-surface']")
            ?.getAttribute("data-note-path"),
        )) === PREVIEW_SOURCE_NOTE_NAME,
      { timeoutMsg: "edge tree drop did not make its file active" },
    );

    await clearWorkspaceStorage();
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  it("keeps already-open tree drops in their center and edge destinations", async () => {
    await clearWorkspaceStorage();
    await browser.refresh();
    await $(`[role="treeitem"][data-path="${TREE_FOLDER_NAME}"]`).waitForExist({
      timeout: 15000,
    });
    await expandTreeFolder();
    await openTreePath(TREE_FIRST_NOTE_NAME);
    await dragTreePathToPane(TREE_SECOND_NOTE_NAME, 0, "left");
    await browser.waitUntil(
      async () => {
        const panes = await paneSnapshots();
        return (
          panes.length === 2 &&
          panes.some((pane) => pane.activePath === TREE_SECOND_NOTE_NAME)
        );
      },
      { timeoutMsg: "center-drop setup did not create two populated panes" },
    );

    const beforeCenter = await paneSnapshots();
    const centerIndex = beforeCenter.findIndex(
      (pane) => pane.activePath === TREE_SECOND_NOTE_NAME,
    );
    const centerId = beforeCenter[centerIndex]?.id;
    const existingCenterHolder = beforeCenter.find(
      (pane) => pane.activePath === TREE_FIRST_NOTE_NAME,
    );
    expect(centerIndex).toBeGreaterThanOrEqual(0);
    expect(centerId).toBeTruthy();
    expect(existingCenterHolder).toBeDefined();
    await dragTreePathToPane(TREE_FIRST_NOTE_NAME, centerIndex, "center");
    await browser.waitUntil(
      async () => {
        const destination = (await paneSnapshots()).find(
          (pane) => pane.id === centerId,
        );
        return (
          destination?.focused === true &&
          destination.activePath === TREE_FIRST_NOTE_NAME &&
          destination.tabs.includes(TREE_FIRST_NOTE_NAME)
        );
      },
      {
        timeoutMsg:
          "already-open center drop left the hovered pane for the existing tab",
      },
    );
    const afterCenter = await paneSnapshots();
    expect(
      afterCenter
        .find((pane) => pane.id === existingCenterHolder?.id)
        ?.tabs.includes(TREE_FIRST_NOTE_NAME),
    ).toBe(true);

    await clearWorkspaceStorage();
    await browser.refresh();
    await $(`[role="treeitem"][data-path="${TREE_FOLDER_NAME}"]`).waitForExist({
      timeout: 15000,
    });
    await expandTreeFolder();
    await openTreePath(TREE_FIRST_NOTE_NAME);
    await dragTreePathToPane(TREE_SECOND_NOTE_NAME, 0, "left");
    await browser.waitUntil(
      async () => {
        const panes = await paneSnapshots();
        return (
          panes.length === 2 && panes.every((pane) => pane.activePath !== null)
        );
      },
      { timeoutMsg: "edge-drop setup did not create two populated panes" },
    );

    const beforeEdge = await paneSnapshots();
    const edgeIndex = beforeEdge.findIndex(
      (pane) => pane.activePath === TREE_SECOND_NOTE_NAME,
    );
    const previousPaneIds = new Set(beforeEdge.map((pane) => pane.id));
    expect(edgeIndex).toBeGreaterThanOrEqual(0);
    await dragTreePathToPane(TREE_FIRST_NOTE_NAME, edgeIndex, "up");
    await browser.waitUntil(
      async () => {
        const panes = await paneSnapshots();
        const created = panes.find(
          (pane) => pane.focused && !previousPaneIds.has(pane.id),
        );
        return (
          panes.length === 3 &&
          created?.activePath === TREE_FIRST_NOTE_NAME &&
          created.tabs.includes(TREE_FIRST_NOTE_NAME)
        );
      },
      {
        timeoutMsg:
          "already-open edge drop did not populate and focus its new pane",
      },
    );
    const afterEdge = await paneSnapshots();
    expect(afterEdge.every((pane) => pane.tabs.length > 0)).toBe(true);
    expect(
      afterEdge.filter((pane) => pane.tabs.includes(TREE_FIRST_NOTE_NAME)),
    ).toHaveLength(2);

    await clearWorkspaceStorage();
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  it("opens, closes, reorders, splits, and restores tabs with a pane tree", async () => {
    await expandTreeFolder();
    await openTreePath(TREE_FIRST_NOTE_NAME);
    for (const path of [TREE_SECOND_NOTE_NAME, PREVIEW_SOURCE_NOTE_NAME]) {
      await browser.execute(
        (element) => {
          (element as HTMLElement).dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              ctrlKey: true,
              metaKey: true,
            }),
          );
        },
        await $(`[role="treeitem"][data-path="${path}"]`).getElement(),
      );
    }
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
    // TabStrip's drag handlers read its own `dragging`/`insertion` state
    // synchronously on each event rather than anything time-sensitive, so
    // these synthetic dispatches need no pacing between them.
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
    // Every pane in a split carries its own strip, including the one the
    // split just created with a single tab in it.
    expect(await $$(".skr-tab-strip")).toHaveLength(2);

    // A pane without focus renders its note through the read-only renderer
    // rather than the editor. That renderer sits outside the editor's own
    // scoped styles, so it once showed the same note at the interface's
    // control size on the interface's leading in a column of unbounded
    // width, and moving focus between panes resized the text and reflowed
    // its tables. The values are read from the live document rather than
    // compared to the markup that produced them, so a rule that stops
    // applying fails here instead of passing.
    const paneTypography = await browser.execute(() =>
      [...document.querySelectorAll(".skr-editor-pane")]
        .map((pane) => {
          const content = pane.querySelector(".cm-content");
          const editor = pane.querySelector(".cm-editor");
          return content === null || editor === null
            ? null
            : {
                fontSize: getComputedStyle(editor).fontSize,
                lineHeight: getComputedStyle(content).lineHeight,
                fontFamily: getComputedStyle(content).fontFamily,
              };
        })
        .filter((entry) => entry !== null),
    );
    expect(paneTypography).toHaveLength(2);
    expect(paneTypography[0]).toEqual(paneTypography[1]);

    await $('[aria-label="More actions"]').click();
    const splitDown = $('[data-command-id="pane.split-down"]');
    await splitDown.waitForDisplayed({ timeout: 10000 });
    await splitDown.click();
    await browser.waitUntil(
      async () => (await $$(".skr-editor-pane").length) === 3,
      { timeoutMsg: "split down did not create a third pane" },
    );
    const dividerAxes = await browser.execute(() =>
      [...document.querySelectorAll(".skr-split-divider")].map((divider) => ({
        orientation: divider.getAttribute("aria-orientation"),
        cursor: getComputedStyle(divider).cursor,
      })),
    );
    expect(dividerAxes).toEqual(
      expect.arrayContaining([
        { orientation: "vertical", cursor: "col-resize" },
        { orientation: "horizontal", cursor: "row-resize" },
      ]),
    );

    // The DOM reflects the new panes before the workspace snapshot persists
    // to localStorage, so poll rather than reading it once immediately
    // after the pane count settles.
    let beforeReload: { layout: unknown; focusedPaneId: string } | null = null;
    await browser.waitUntil(
      async () => {
        beforeReload = (await workspaceSnapshot()) as typeof beforeReload;
        return beforeReload !== null && paneCountOf(beforeReload.layout) === 3;
      },
      {
        // The persist runs off a Svelte effect queued behind whatever the
        // split itself is doing (opening the new pane's note), which under
        // CPU contention can take much longer than its steady-state flush.
        timeout: 45000,
        timeoutMsg: "workspace snapshot did not persist the pane tree",
      },
    );
    if (beforeReload === null) {
      throw new Error("workspace snapshot is unexpectedly null");
    }

    await browser.refresh();
    await browser.waitUntil(
      async () => (await $$(".skr-editor-pane").length) === 3,
      { timeout: 45000, timeoutMsg: "split workspace did not restore" },
    );
    let afterReload: typeof beforeReload = null;
    await browser.waitUntil(
      async () => {
        afterReload = (await workspaceSnapshot()) as typeof beforeReload;
        return afterReload !== null && paneCountOf(afterReload.layout) === 3;
      },
      {
        timeout: 45000,
        timeoutMsg: "workspace snapshot did not restore the pane tree",
      },
    );
    if (afterReload === null) {
      throw new Error("workspace snapshot is unexpectedly null");
    }
    expect(afterReload.layout).toEqual(beforeReload.layout);
    expect(afterReload.focusedPaneId).toBe(beforeReload.focusedPaneId);

    // Closing each pane's last tab collapses it into its sibling until one
    // pane holds the whole editor area again.
    await browser.waitUntil(
      async () => {
        if ((await $$(".skr-editor-pane").length) === 1) return true;
        await browser.keys([modifierKey, "w"]);
        return false;
      },
      { timeout: 30000, timeoutMsg: "panes did not collapse as tabs closed" },
    );
    expect(await $$(".skr-split-divider")).toHaveLength(0);
  });
});
