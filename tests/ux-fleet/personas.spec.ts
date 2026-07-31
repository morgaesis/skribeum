import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  installUxInstrumentation,
  PersonaSession,
  type VisualCheck,
} from "./signals";
import { FLEET_NOTE_COUNT, FLEET_SEED, NOTES } from "./vault";
import {
  CONSTRUCTS,
  captureMatrix,
  compareReference,
  inspectComputedVisibility,
  inspectConstruct,
  resetEvidence,
  setTheme,
  writeGallery,
} from "./visual";

const modifier = process.platform === "darwin" ? Key.Command : Key.Ctrl;

class Flow {
  readonly session: PersonaSession;
  constructor(
    readonly id: string,
    persona: string,
    readonly intent: string,
    seed: number,
  ) {
    this.session = new PersonaSession(id, persona, seed);
  }

  async open(
    path: string,
    text: string,
    selector = ".cm-content",
  ): Promise<void> {
    await this.session.interact({
      intent: this.intent,
      action: `Open ${path} through the quick switcher`,
      perform: async () => {
        await browser.keys([modifier, "o"]);
        const input = $('[role="combobox"][aria-label="Quick switcher"]');
        await input.waitForExist({ timeout: 15_000 });
        await input.setValue(path);
        await browser.waitUntil(
          async () => {
            const option = $('[role="option"]');
            return (
              (await option.isExisting()) &&
              (await option.getText()).includes(path)
            );
          },
          {
            timeout: 15_000,
            timeoutMsg: `quick switcher did not find ${path}`,
          },
        );
        await browser.keys(Key.Enter);
      },
      visible: { selector, text },
      trigger: { event: "keydown", key: "o" },
      latencyKind: "note",
      expectedFocus: [selector],
    });
  }

  async type(action: string, value: string, expected: string): Promise<void> {
    await browser.execute(() =>
      document.querySelector<HTMLElement>(".cm-content")?.focus(),
    );
    await this.session.interact({
      intent: this.intent,
      action,
      perform: async () => $(".cm-content").addValue(value),
      visible: { selector: ".cm-content", text: expected },
      trigger: { event: "beforeinput" },
      latencyKind: "glyph",
      expectedFocus: [".cm-content"],
    });
  }

  async tree(path: string, text: string): Promise<void> {
    const parts = path.split("/");
    const name = parts.at(-1) ?? path;
    await this.session.interact({
      intent: this.intent,
      action: `Open ${path} through the vault tree`,
      perform: async () => {
        for (const folder of parts.slice(0, -1)) {
          if (!(await $(`li=${name}`).isExisting())) {
            const row = $(`li=${folder}`);
            await row.waitForExist({ timeout: 15_000 });
            await row.click();
          }
        }
        const row = $(`li=${name}`);
        await row.waitForExist({ timeout: 15_000 });
        await row.click();
      },
      visible: { selector: ".cm-content", text },
      trigger: { event: "click" },
      latencyKind: "note",
    });
  }

  async surface(chord: string[], label: string): Promise<void> {
    await this.session.interact({
      intent: this.intent,
      action: `Open ${label}`,
      perform: () => browser.keys(chord),
      visible: { selector: `[aria-label="${label}"]` },
      trigger: { event: "keydown", key: chord.at(-1)?.toString() },
      latencyKind: "surface",
    });
  }

  async evidence(): Promise<void> {
    await captureMatrix("persona", this.id);
  }
}

async function moveCursorAway(): Promise<void> {
  if (!(await $(".cm-content").isExisting())) return;
  await browser.execute(() => {
    const lines = document.querySelectorAll<HTMLElement>(".cm-line");
    lines.item(lines.length - 1)?.click();
    document.querySelector<HTMLElement>(".cm-content")?.focus();
  });
  await browser.keys([modifier, Key.End]);
  await browser.execute(() => {
    const scroller = document.querySelector<HTMLElement>(".cm-scroller");
    if (scroller !== null) scroller.scrollTop = 0;
  });
}

async function visualRecord(
  flow: Flow,
  action: string,
  inspect: () => Promise<VisualCheck[]>,
): Promise<void> {
  await flow.session.interact({
    intent: flow.intent,
    action,
    perform: async () => {},
    inspect,
  });
}

async function humanReadingTour(flow: Flow, treeOnly = false): Promise<void> {
  const open = (path: string, text: string) =>
    treeOnly ? flow.tree(path, text) : flow.open(path, text);
  await open(NOTES.start, "Quickstart");
  const link = $(".cm-skr-wikilink-alias");
  await link.scrollIntoView();
  await flow.session.interact({
    intent: flow.intent,
    action: "Click a rendered link and expect navigation",
    perform: () => link.click(),
    inspect: async () => {
      const navigated = await browser.execute(
        () =>
          document
            .querySelector<HTMLElement>(".cm-content")
            ?.innerText.includes("Vault index") ?? false,
      );
      return [
        {
          id: "wikilink-navigation",
          construct: "Wikilinks",
          pass: navigated,
          expected: "the linked note opens",
          actual: navigated ? "Vault index opened" : "click did not navigate",
        },
      ];
    },
  });
  await open("Features/code-blocks.md", "Code blocks");
  await $(".cm-skr-code-block").moveTo();
  await visualRecord(
    flow,
    "Hover a code block for its copy affordance",
    async () => {
      const copy = await browser.execute(() =>
        [...document.querySelectorAll<HTMLElement>("button")].some(
          (button) =>
            button.getClientRects().length > 0 &&
            /copy/i.test(
              `${button.textContent} ${button.getAttribute("aria-label")}`,
            ),
        ),
      );
      return [
        {
          id: "fenced-code-copy",
          construct: "Fenced code",
          pass: copy,
          expected: "a visible copy affordance on hover",
          actual: copy ? "copy control visible" : "copy control absent",
        },
      ];
    },
  );
  await open("Features/frontmatter.md", "Frontmatter");
  await flow.session.interact({
    intent: flow.intent,
    action: "Collapse and expand frontmatter properties",
    perform: async () => {
      const toggle = $('[aria-label="Note properties"] button');
      if (await toggle.isExisting()) {
        await toggle.click();
        await toggle.click();
      }
    },
    inspect: async () => {
      const toggle = await browser.execute(
        () =>
          document.querySelector('[aria-label="Note properties"] button') !==
          null,
      );
      return [
        {
          id: "frontmatter-toggle",
          construct: "Frontmatter properties",
          pass: toggle,
          expected: "a collapse and expand control",
          actual: toggle ? "toggle exercised" : "toggle absent",
        },
      ];
    },
  });
  await open(NOTES.research, "Long paper");
  await flow.session.interact({
    intent: flow.intent,
    action: "Scroll through a long note",
    perform: () =>
      browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(".cm-scroller");
        if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
      }),
    scrollExpected: true,
    inspect: async () => {
      const moved = await browser.execute(
        () =>
          (document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop ??
            0) > 0,
      );
      return [
        {
          id: "long-note-scroll",
          construct: "Long note",
          pass: moved,
          expected: "later content becomes reachable",
          actual: moved ? "later content reached" : "scroll did not move",
        },
      ];
    },
  });
  await flow.evidence();
}

before(async () => {
  resetEvidence();
  await browser.tauri.switchWindow("main");
  await browser.setWindowSize(1280, 800);
  await $(`li=${NOTES.start}`).waitForExist({ timeout: 120_000 });
  await installUxInstrumentation();
});

after(() => writeGallery());

describe("persona-driven UX fleet", () => {
  it("runs the Obsidian migrant session", async () => {
    const flow = new Flow(
      "01-obsidian-migrant",
      "Obsidian migrant",
      `Audit a ${FLEET_NOTE_COUNT}-note imported vault and reach deeply nested material`,
      FLEET_SEED + 1,
    );
    await flow.open("quickstart.md", "Quickstart");
    await flow.open(NOTES.deep, "Deep migration note");
    await flow.surface([modifier, Key.Shift, "f"], "Search vault");
    await $('[role="combobox"]').setValue("fleet-search-token-deep");
    await $('[role="option"]').waitForExist({ timeout: 20_000 });
    await browser.keys(Key.Escape);
    await humanReadingTour(flow);
  });

  it("runs the daily journaler session", async () => {
    const flow = new Flow(
      "02-daily-journaler",
      "Daily journaler",
      "Capture a daily entry, add links quickly, and move between linked notes",
      FLEET_SEED + 2,
    );
    await flow.open("quickstart.md", "Quickstart");
    await flow.open(NOTES.daily, "2026-07-31");
    await flow.type(
      "Type a journal heading and wikilink",
      "\n## Afternoon capture\nLinked [[Daily/2026-07-30]] while writing.",
      "while writing",
    );
    await flow.session.interact({
      intent: flow.intent,
      action: "Save the journal entry",
      perform: () => browser.keys([modifier, "s"]),
      expectedFocus: [".cm-content"],
    });
    await flow.open(NOTES.linkedDaily, "linked journal entry");
    await humanReadingTour(flow);
  });

  it("runs the researcher session", async () => {
    const flow = new Flow(
      "03-researcher",
      "Researcher with long documents",
      "Review a long document, search it, edit tables, and scroll its full length",
      FLEET_SEED + 3,
    );
    await flow.open("quickstart.md", "Quickstart");
    await flow.open(NOTES.research, "Long paper");
    await flow.session.interact({
      intent: flow.intent,
      action: "Scroll the long paper to its final evidence rows",
      perform: () =>
        browser.execute(() => {
          const scroller = document.querySelector<HTMLElement>(".cm-scroller");
          if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
        }),
      scrollExpected: true,
      expectedFocus: [".cm-content"],
    });
    await flow.open("Features/tables.md", "Room comparison");
    await visualRecord(flow, "Check the rendered research table", () =>
      inspectConstruct(
        CONSTRUCTS.find((item) => item.id === "tables") ?? CONSTRUCTS[8],
      ),
    );
    await humanReadingTour(flow);
  });

  it("runs the keyboard-only power-user session", async () => {
    const flow = new Flow(
      "04-keyboard-power-user",
      "Keyboard-only power user",
      "Navigate core command surfaces without pointer input and preserve useful focus",
      FLEET_SEED + 4,
    );
    await flow.open("quickstart.md", "Quickstart");
    await flow.open(NOTES.keyboard, "Command surface");
    await flow.surface([modifier, "p"], "Command palette");
    await $('[role="combobox"]').setValue("toggle outline");
    await $('[role="option"]').waitForExist({ timeout: 10_000 });
    await browser.keys(Key.Enter);
    await $('[role="tree"][aria-label="Outline"]').waitForExist({
      timeout: 10_000,
    });
    await browser.keys([modifier, Key.Shift, "o"]);
    await humanReadingTour(flow);
  });

  it("runs the low-vision session", async () => {
    const flow = new Flow(
      "05-low-vision",
      "Low-vision user",
      "Use dark theme at 200 percent page zoom without clipping or lost focus",
      FLEET_SEED + 5,
    );
    await flow.open("quickstart.md", "Quickstart");
    await setTheme("dark");
    await flow.open(NOTES.zoom, "Zoom review");
    await flow.session.interact({
      intent: flow.intent,
      action: "Enlarge the WebView to 200 percent",
      perform: () =>
        browser.execute(() => {
          document.documentElement.style.zoom = "2";
        }),
      custom: () =>
        browser.execute(() => ({
          horizontalOverflowPx: Math.max(
            0,
            document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        })),
    });
    await flow.surface([modifier, "p"], "Command palette");
    await browser.keys(Key.Escape);
    await browser.execute(() => {
      document.documentElement.style.zoom = "";
    });
    await humanReadingTour(flow);
  });

  it("runs the interruption-prone session", async () => {
    const flow = new Flow(
      "06-interruption-prone",
      "Interruption-prone user",
      "Switch notes during edits and dismiss transient surfaces at unpredictable points",
      FLEET_SEED + 6,
    );
    await flow.open("quickstart.md", "Quickstart");
    await flow.open(NOTES.interruption, "Interrupted draft");
    await flow.type(
      "Type a short burst before an interruption",
      " before an interruption",
      "before an interruption",
    );
    await flow.surface([modifier, "p"], "Command palette");
    await browser.keys(Key.Escape);
    await flow.open(NOTES.interruptionTarget, "Reference during interruption");
    await humanReadingTour(flow);
  });

  it("runs the skimmer session without typing", async () => {
    const flow = new Flow(
      "07-skimmer",
      "Skimmer",
      "Read and navigate without editing, following links and checking reading affordances",
      FLEET_SEED + 7,
    );
    await humanReadingTour(flow, true);
  });

  it("runs the checker session across the complete rendering surface", async () => {
    const flow = new Flow(
      "08-checker",
      "Checker",
      "Verify that each visible construct matches its deterministic Markdown source",
      FLEET_SEED + 8,
    );
    await flow.open("quickstart.md", "Quickstart");
    for (const construct of CONSTRUCTS) {
      await flow.open(
        construct.path,
        construct.rendered,
        construct.id === "canvas" ? construct.selector : ".cm-content",
      );
      await moveCursorAway();
      if (construct.id === "fenced-code") await $(construct.selector).moveTo();
      await visualRecord(flow, `Assert rendered ${construct.id}`, () =>
        inspectConstruct(construct),
      );
      await captureMatrix("construct", construct.id);
      if (["headings", "math-inline", "canvas"].includes(construct.id)) {
        await visualRecord(
          flow,
          `Compare ${construct.id} with its pixel reference`,
          async () => [
            await compareReference(construct.id, construct.selector),
          ],
        );
      }
    }

    await flow.open("quickstart.md", "Quickstart");
    await setTheme("dark");
    await $(".cm-line").click();
    await browser.keys(Key.Home);
    await browser.keys([Key.Shift, Key.End]);
    await $(".cm-skr-selection-toolbar").waitForExist({ timeout: 10_000 });
    await visualRecord(
      flow,
      "Measure caret, toolbar, and interactive chrome visibility",
      inspectComputedVisibility,
    );
    await humanReadingTour(flow);
  });
});
