import { $, $$, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

const modifierKey = process.platform === "darwin" ? Key.Command : Key.Ctrl;
let testRun = 0;

type ClipboardReadback = {
  done: boolean;
  text: string;
  error: string | null;
};

async function overlayInput() {
  const input = $('[role="combobox"]');
  await input.waitForExist({ timeout: 10000 });
  return input;
}

async function readClipboardText() {
  await browser.execute(() => {
    const state: ClipboardReadback = { done: false, text: "", error: null };
    const stateWindow = window as Window & {
      __skribeumClipboardReadback?: ClipboardReadback;
    };
    stateWindow.__skribeumClipboardReadback = state;
    const activation = document.createElement("button");
    activation.dataset.testid = "clipboard-readback-activation";
    activation.style.position = "fixed";
    activation.style.inset = "0 auto auto 0";
    activation.style.width = "24px";
    activation.style.height = "24px";
    activation.style.opacity = "0.01";
    activation.style.zIndex = "2147483647";
    activation.addEventListener(
      "click",
      async () => {
        try {
          state.text = await navigator.clipboard.readText();
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
        } finally {
          state.done = true;
          activation.remove();
        }
      },
      { once: true },
    );
    document.body.append(activation);
  });
  await $('[data-testid="clipboard-readback-activation"]').click();
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          (
            window as Window & {
              __skribeumClipboardReadback?: ClipboardReadback;
            }
          ).__skribeumClipboardReadback?.done === true,
      ),
    {
      timeout: 5000,
      timeoutMsg: "clipboard readback did not complete",
    },
  );
  const readback = await browser.execute(
    () =>
      (
        window as Window & {
          __skribeumClipboardReadback?: ClipboardReadback;
        }
      ).__skribeumClipboardReadback,
  );
  if (readback === undefined) throw new Error("clipboard readback is missing");
  if (readback.error !== null) throw new Error(readback.error);
  return readback.text;
}

async function selectEditorText(text: string) {
  await browser.execute((needle: string) => {
    const root = document.querySelector(".cm-content");
    if (root === null) throw new Error("editor content missing");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      const start = node.textContent?.indexOf(needle) ?? -1;
      if (start < 0) continue;
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

before(async () => {
  await browser.tauri.switchWindow("main");
});

beforeEach(async () => {
  const demoUrl = process.env.SKRIBEUM_E2E_DEMO_URL;
  if (demoUrl === undefined) throw new Error("browser demo URL is unavailable");
  const target = new URL(demoUrl);
  testRun += 1;
  target.searchParams.set("test-run", String(testRun));
  await browser.url(target.href);
  await $(".demo-shell").waitForExist({ timeout: 15000 });
  await browser.waitUntil(
    async () => new URL(await browser.getUrl()).searchParams.has("note"),
    { timeout: 15000, timeoutMsg: "browser demo note address did not load" },
  );
});

describe("work package 1 browser behavior", () => {
  it("routes prefixes and aliases through one result-kind surface", async () => {
    const assertResultKind = async (kind: string) => {
      const list = $(
        '[data-testid="unified-command-surface"] [role="listbox"]',
      );
      expect(await list.getAttribute("data-result-kind")).toBe(kind);
      const options = await list.$$('[role="option"]');
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        expect(await option.getAttribute("data-result-kind")).toBe(kind);
      }
    };

    await browser.keys([modifierKey, "k"]);
    let input = await overlayInput();
    expect(await input.getValue()).toBe("");
    expect(await input.getAttribute("data-search-mode")).toBe("file");
    await assertResultKind("file");
    await input.addValue("link");
    const commandGroup = $(
      '.command-surface-group[data-result-kind="command"]',
    );
    await commandGroup.waitForExist({ timeout: 10000 });
    const tagGroup = $('.command-surface-group[data-result-kind="tag"]');
    await tagGroup.waitForExist({ timeout: 10000 });
    const groupKinds = await browser.execute(() => {
      const kinds = new Map<string, Set<string>>();
      for (const option of document.querySelectorAll<HTMLElement>(
        '[data-testid="unified-command-surface"] [role="option"]',
      )) {
        const group = option.dataset.resultGroup;
        const kind = option.dataset.resultKind;
        if (group === undefined || group.length === 0 || kind === undefined)
          continue;
        const groupSet = kinds.get(group) ?? new Set<string>();
        groupSet.add(kind);
        kinds.set(group, groupSet);
      }
      return [...kinds].map(([group, groupSet]) => [group, [...groupSet]]);
    });
    expect(groupKinds.every(([, kinds]) => kinds.length === 1)).toBe(true);
    expect(
      await $('[data-result-group="Commands and settings"] kbd').getText(),
    ).toBe(">");
    expect(await $('[data-result-group="Tags"] kbd').getText()).toBe("#");
    await input.setValue("");
    await input.addValue(">");
    expect(await input.getAttribute("data-search-mode")).toBe("command");
    await assertResultKind("command");
    await browser.keys(Key.Escape);

    for (const [keys, expected] of [
      [[modifierKey, "o"], ""],
      [[modifierKey, "p"], ">"],
      [[modifierKey, Key.Shift, "p"], ">"],
      [[modifierKey, Key.Shift, "f"], "?"],
    ] as const) {
      await browser.keys([...keys]);
      input = await overlayInput();
      expect(await input.getValue()).toBe(expected);
      expect(
        await $('[data-testid="unified-command-surface"]').isExisting(),
      ).toBe(true);
      await browser.keys(Key.Escape);
    }

    await browser.keys([modifierKey, "k"]);
    input = await overlayInput();
    await input.addValue("#");
    await browser.waitUntil(
      async () => (await $$('[role="option"]')).length > 0,
      {
        timeout: 10000,
        timeoutMsg: "tag mode did not list tags",
      },
    );
    await assertResultKind("tag");
    await input.setValue("?cedar");
    await browser.waitUntil(
      async () => (await $$('[role="option"]')).length > 0,
      {
        timeout: 20000,
        timeoutMsg: "text mode did not list note matches",
      },
    );
    await assertResultKind("text");
  });

  it("opens and focuses the setting action target", async () => {
    await browser.keys([modifierKey, "p"]);
    const input = await overlayInput();
    expect(await input.getValue()).toBe(">");
    await input.addValue("line width");
    const action = $('[data-command-id="setting.appearance.line-width"]');
    await action.waitForExist({ timeout: 10000 });
    expect(await action.getAttribute("data-action-kind")).toBe("setting");
    await action.click();
    await $('[data-setting-id="appearance.line-width"]').waitForDisplayed({
      timeout: 10000,
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.activeElement?.closest<HTMLElement>("[data-setting-id]")
              ?.dataset.settingId === "appearance.line-width",
        ),
      {
        timeout: 10000,
        timeoutMsg: "line-width control did not receive focus",
      },
    );
  });

  it("anchors the narrow surface to the visual viewport", async () => {
    try {
      await browser.setWindowSize(700, 700);
      await browser.waitUntil(
        async () => browser.execute(() => window.innerWidth <= 960),
        { timeout: 10000, timeoutMsg: "viewport did not become narrow" },
      );
      await browser.keys([modifierKey, "k"]);
      await overlayInput();
      const geometry = await browser.execute(() => {
        const backdrop = document.querySelector<HTMLElement>(
          '[data-testid="unified-command-surface"]',
        );
        const dialog = document.querySelector<HTMLElement>(
          ".command-surface-dialog",
        );
        const results = document.querySelector<HTMLElement>(
          ".command-surface-results",
        );
        if (backdrop === null || dialog === null || results === null) {
          throw new Error("command surface geometry is unavailable");
        }
        const viewport = window.visualViewport;
        const backdropBox = backdrop.getBoundingClientRect();
        const dialogBox = dialog.getBoundingClientRect();
        const dialogStyle = getComputedStyle(dialog);
        return {
          backdropTop: backdropBox.top,
          backdropLeft: backdropBox.left,
          backdropWidth: backdropBox.width,
          dialogTop: dialogBox.top,
          dialogHeight: dialogBox.height,
          visualTop: viewport?.offsetTop ?? 0,
          visualLeft: viewport?.offsetLeft ?? 0,
          visualWidth: viewport?.width ?? window.innerWidth,
          visualHeight: viewport?.height ?? window.innerHeight,
          layoutHeight: window.innerHeight,
          topRadius: dialogStyle.borderTopLeftRadius,
          bottomRadius: dialogStyle.borderBottomLeftRadius,
          resultOverflow: getComputedStyle(results).overflowY,
        };
      });
      expect(Math.abs(geometry.backdropTop - geometry.visualTop)).toBeLessThan(
        2,
      );
      expect(
        Math.abs(geometry.backdropLeft - geometry.visualLeft),
      ).toBeLessThan(2);
      expect(
        Math.abs(geometry.backdropWidth - geometry.visualWidth),
      ).toBeLessThan(2);
      expect(Math.abs(geometry.dialogTop - geometry.visualTop)).toBeLessThan(2);
      expect(geometry.dialogHeight).toBeLessThanOrEqual(
        Math.min(geometry.visualHeight, geometry.layoutHeight * 0.8) + 2,
      );
      expect(geometry.topRadius).toBe("0px");
      expect(geometry.bottomRadius).not.toBe("0px");
      expect(geometry.resultOverflow).toBe("auto");
    } finally {
      await browser.keys(Key.Escape);
      await browser.setWindowSize(1100, 750);
    }
  });

  it("copies the browser URL and shows registry toolbar tooltips", async () => {
    const expectedLink = await browser.getUrl();
    await browser.keys([modifierKey, "k"]);
    let input = await overlayInput();
    await input.addValue(">copy link to note");
    const copyCommand = $('[data-command-id="link.copy-note"]');
    await copyCommand.waitForExist({ timeout: 10000 });
    await copyCommand.click();
    expect(await readClipboardText()).toBe(expectedLink);

    await browser.keys([modifierKey, Key.Shift, "o"]);
    const outline = $('[role="tree"][aria-label="Outline"]');
    await outline.waitForExist({ timeout: 10000 });
    await browser.execute(() => {
      const row = [
        ...document.querySelectorAll<HTMLElement>('[role="treeitem"]'),
      ].find((candidate) => candidate.textContent?.includes("1. Look around"));
      row
        ?.querySelector<HTMLButtonElement>(
          '[data-command-id="link.copy-heading"]',
        )
        ?.click();
    });
    const headingLink = new URL(expectedLink);
    headingLink.hash = encodeURIComponent("1. Look around");
    await browser.waitUntil(
      async () => (await readClipboardText()) === headingLink.href,
      { timeout: 5000, timeoutMsg: "outline heading link was not copied" },
    );

    await browser.keys([modifierKey, "k"]);
    input = await overlayInput();
    await input.addValue(">bold");
    const paletteBold = $('[data-command-id="format.bold"]');
    await paletteBold.waitForExist({ timeout: 10000 });
    const displayedBinding = await paletteBold.$("kbd").getText();
    await browser.keys(Key.Escape);

    await selectEditorText("Quickstart");
    const toolbar = $(".cm-skr-selection-toolbar");
    await toolbar.waitForExist({ timeout: 5000 });
    const buttons = await toolbar.$$("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(await button.getAttribute("title")).toBeNull();
    }
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-command-id="format.bold"]')
        ?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    });
    await browser.pause(300);
    expect(await $(".cm-skr-toolbar-command-tooltip").isExisting()).toBe(false);
    const tooltip = $(".cm-skr-toolbar-command-tooltip");
    await tooltip.waitForExist({ timeout: 1000 });
    expect(await tooltip.getText()).toContain("Bold");
    expect(await tooltip.$("kbd").getText()).toBe(displayedBinding);
    await browser.execute(() => {
      const button = document.querySelector<HTMLElement>(
        '[data-command-id="format.bold"]',
      );
      button?.dispatchEvent(
        new PointerEvent("pointerleave", { bubbles: true }),
      );
      button?.focus();
    });
    await tooltip.waitForExist({ timeout: 500 });
    expect(await tooltip.$("kbd").getText()).toBe(displayedBinding);
  });
});
