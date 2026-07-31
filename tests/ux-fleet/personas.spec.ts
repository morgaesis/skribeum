import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import { installUxInstrumentation, PersonaSession } from "./signals";
import { FLEET_NOTE_COUNT, FLEET_SEED, NOTES } from "./vault";

const modifier = process.platform === "darwin" ? Key.Command : Key.Ctrl;

class Flow {
  readonly session: PersonaSession;

  constructor(
    id: string,
    persona: string,
    readonly intent: string,
    seed: number,
  ) {
    this.session = new PersonaSession(id, persona, seed);
  }

  async surface(
    action: string,
    chord: string[],
    label: string,
    key: string,
    selector = `[role="combobox"][aria-label="${label}"]`,
    focus = selector,
  ): Promise<void> {
    await this.session.interact({
      intent: this.intent,
      action,
      perform: () => browser.keys(chord),
      visible: { selector, text: null },
      trigger: { event: "keydown", key },
      latencyKind: "surface",
      expectedFocus: [focus],
    });
  }

  async query(query: string, expected: string): Promise<void> {
    await this.session.interact({
      intent: this.intent,
      action: `Type ${JSON.stringify(query)} into the open picker`,
      perform: async () => $('[role="combobox"]').addValue(query),
      visible: { selector: '[role="option"]', text: expected },
      expectedFocus: ['[role="combobox"]'],
    });
  }

  async pick(action: string, content: string): Promise<void> {
    await this.session.interact({
      intent: this.intent,
      action,
      perform: () => browser.keys(Key.Enter),
      visible: { selector: ".cm-content", text: content },
      trigger: { event: "keydown", key: "Enter" },
      latencyKind: "note",
      expectedFocus: [".cm-content"],
    });
  }

  async close(selector = '[role="dialog"]'): Promise<void> {
    await this.session.interact({
      intent: this.intent,
      action: "Press Escape to close the active surface",
      perform: () => browser.keys(Key.Escape),
      visible: { selector, text: null, absent: true },
      expectedFocus: [".cm-content"],
    });
  }

  async click(name: string, content: string): Promise<void> {
    await this.session.interact({
      intent: this.intent,
      action: `Click ${name} in the vault tree`,
      perform: async () => $(`li=${name}`).click(),
      visible: { selector: ".cm-content", text: content },
      trigger: { event: "click", key: null },
      latencyKind: "note",
      expectedFocus: ['[role="treeitem"]'],
    });
  }

  async type(action: string, text: string, content: string): Promise<void> {
    await browser.execute(() =>
      document.querySelector<HTMLElement>(".cm-content")?.focus(),
    );
    await this.session.interact({
      intent: this.intent,
      action,
      perform: async () => $(".cm-content").addValue(text),
      visible: { selector: ".cm-content", text: content },
      trigger: { event: "beforeinput", key: null },
      latencyKind: "glyph",
      expectedFocus: [".cm-content"],
    });
  }

  async quickNote(query: string, path: string, content: string): Promise<void> {
    await this.surface(
      "Press Ctrl+O to open the quick switcher",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await this.query(query, path);
    await this.pick(`Press Enter to open ${path}`, content);
  }
}

before(async () => {
  await browser.tauri.switchWindow("main");
  await browser.setWindowSize(1280, 800);
  await $(`li=${NOTES.start}`).waitForExist({ timeout: 120_000 });
  await installUxInstrumentation();
});

describe("persona-driven UX fleet", () => {
  it("runs the Obsidian migrant session", async () => {
    const flow = new Flow(
      "01-obsidian-migrant",
      "Obsidian migrant",
      `Audit a ${FLEET_NOTE_COUNT}-note imported vault and reach deeply nested material`,
      FLEET_SEED + 1,
    );
    await flow.click("Start Here.md", "Start here");
    await flow.quickNote("Deep Note 0199", NOTES.deep, "Deep migration note");
    await flow.surface(
      "Press Ctrl+Shift+F to search the imported vault",
      [modifier, Key.Shift, "f"],
      "Search vault",
      "F",
    );
    await flow.query("fleet-search-token-deep", "Deep");
    await flow.pick(
      "Press Enter on the ranked deep-note result",
      "Deep migration note",
    );
    await flow.surface(
      "Open the quick switcher to revisit recent notes",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await flow.close();
  });

  it("runs the daily journaler session", async () => {
    const flow = new Flow(
      "02-daily-journaler",
      "Daily journaler",
      "Capture a daily entry, add links quickly, and move between linked notes",
      FLEET_SEED + 2,
    );
    await flow.quickNote("2026-07-31", NOTES.daily, "2026-07-31");
    await flow.type(
      "Type a new journal heading",
      "\n## Afternoon capture",
      "Afternoon capture",
    );
    await flow.type(
      "Type a wikilink without pausing",
      "\nLinked [[Daily/2026-07-30]] while writing.",
      "while writing",
    );
    await flow.session.interact({
      intent: flow.intent,
      action: "Press Ctrl+S to save the journal entry",
      perform: () => browser.keys([modifier, "s"]),
      expectedFocus: [".cm-content"],
    });
    await flow.quickNote(
      "2026-07-30",
      NOTES.linkedDaily,
      "linked journal entry",
    );
  });

  it("runs the researcher session", async () => {
    const flow = new Flow(
      "03-researcher",
      "Researcher with long documents",
      "Review a long document, paste evidence, search within it, and edit tables",
      FLEET_SEED + 3,
    );
    await flow.quickNote("Long Paper", NOTES.research, "Long paper");
    const paste = Array.from(
      { length: 80 },
      (_, index) =>
        `\nEvidence paste ${index}: result ${index * 19} cites [[Deep Note ${String(index).padStart(4, "0")}]].`,
    ).join("");
    await flow.type(
      "Paste an 80-paragraph evidence extract",
      paste,
      "Evidence paste 79",
    );
    await flow.session.interact({
      intent: flow.intent,
      action: "Press Ctrl+F to open in-note find",
      perform: () => browser.keys([modifier, "f"]),
      visible: { selector: ".cm-skr-find-input", text: null },
      trigger: { event: "keydown", key: "f" },
      latencyKind: "surface",
      expectedFocus: [".cm-skr-find-input"],
    });
    await flow.session.interact({
      intent: flow.intent,
      action: "Search the long paper for Evidence 219",
      perform: async () => $(".cm-skr-find-input").addValue("Evidence 219"),
      visible: { selector: ".cm-skr-find-count", text: "1" },
      expectedFocus: [".cm-skr-find-input"],
    });
    await flow.close(".cm-skr-find-panel");
    await flow.surface(
      "Press Ctrl+P to open the command palette",
      [modifier, "p"],
      "Command palette",
      "p",
    );
    await flow.query("insert table", "Table");
    await flow.pick("Press Enter to insert a table", "Column 1");
  });

  it("runs the keyboard-only power-user session", async () => {
    const flow = new Flow(
      "04-keyboard-power-user",
      "Keyboard-only power user",
      "Navigate core command surfaces without pointer input and preserve useful focus",
      FLEET_SEED + 4,
    );
    await flow.quickNote("Command Surface", NOTES.keyboard, "Command surface");
    await flow.surface(
      "Press Ctrl+P to open the command palette",
      [modifier, "p"],
      "Command palette",
      "p",
    );
    await flow.query("toggle outline", "outline");
    await flow.session.interact({
      intent: flow.intent,
      action: "Press Enter to open the outline panel",
      perform: () => browser.keys(Key.Enter),
      visible: {
        selector: '[role="tree"][aria-label="Outline"]',
        text: "Command surface",
      },
      trigger: { event: "keydown", key: "Enter" },
      latencyKind: "surface",
      expectedFocus: [".cm-content"],
    });
    await flow.session.interact({
      intent: flow.intent,
      action: "Press Tab from the editor toward the outline",
      perform: () => browser.keys(Key.Tab),
      expectedFocus: ['[role="tree"][aria-label="Outline"] [role="treeitem"]'],
      custom: async () => ({ nativeTabTraversal: false }),
    });
    await browser.execute(() =>
      document
        .querySelector<HTMLElement>(
          '[role="tree"][aria-label="Outline"] [role="treeitem"]',
        )
        ?.focus(),
    );
    await flow.session.interact({
      intent: flow.intent,
      action: "Press Enter on the focused outline heading",
      perform: () => browser.keys(Key.Enter),
      expectedFocus: [".cm-content"],
      scrollExpected: true,
    });
    await flow.surface(
      "Press Ctrl+, to open settings",
      [modifier, ","],
      "Settings",
      ",",
      '[data-testid="settings-view"]',
      '[data-testid="settings-theme"]',
    );
    await flow.close('[data-testid="settings-view"]');
  });

  it("runs the low-vision session", async () => {
    const flow = new Flow(
      "05-low-vision",
      "Low-vision user",
      "Use dark theme at 200 percent page zoom without clipping or lost focus",
      FLEET_SEED + 5,
    );
    await flow.surface(
      "Press Ctrl+, to open visual settings",
      [modifier, ","],
      "Settings",
      ",",
      '[data-testid="settings-view"]',
      '[data-testid="settings-theme"]',
    );
    await flow.session.interact({
      intent: flow.intent,
      action: "Choose dark theme through the settings binding",
      perform: () =>
        browser.execute(() => {
          const select = document.querySelector<HTMLSelectElement>(
            '[data-testid="settings-theme"]',
          );
          if (select) {
            select.value = "dark";
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }),
      expectedFocus: ['[data-testid="settings-theme"]'],
    });
    await flow.close('[data-testid="settings-view"]');
    await flow.session.interact({
      intent: flow.intent,
      action: "Apply a 200 percent WebView page zoom approximation",
      perform: () =>
        browser.execute(() => {
          document.documentElement.style.zoom = "2";
        }),
      expectedFocus: [".cm-content"],
      custom: () =>
        browser.execute(() => ({
          horizontalOverflowPx: Math.max(
            0,
            document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        })),
    });
    await flow.surface(
      "Press Ctrl+P while the page is enlarged",
      [modifier, "p"],
      "Command palette",
      "p",
    );
    await flow.close();
    await browser.execute(() => {
      document.documentElement.style.zoom = "";
    });
  });

  it("runs the interruption-prone session", async () => {
    const flow = new Flow(
      "06-interruption-prone",
      "Interruption-prone user",
      "Switch notes during edits and dismiss transient surfaces at unpredictable points",
      FLEET_SEED + 6,
    );
    await flow.quickNote(
      "Interrupted draft",
      NOTES.interruption,
      "Interrupted draft",
    );
    await flow.type(
      "Type a short burst into the draft",
      " before an interruption",
      "before an interruption",
    );
    await flow.surface(
      "Open the command palette in the middle of editing",
      [modifier, "p"],
      "Command palette",
      "p",
    );
    await flow.close();
    await flow.quickNote(
      "Reference",
      NOTES.interruptionTarget,
      "Reference during interruption",
    );
    await flow.surface(
      "Open settings immediately after the note switch",
      [modifier, ","],
      "Settings",
      ",",
      '[data-testid="settings-view"]',
      '[data-testid="settings-theme"]',
    );
    await flow.close('[data-testid="settings-view"]');
    await flow.session.interact({
      intent: flow.intent,
      action: "Press Escape again with no transient surface open",
      perform: () => browser.keys(Key.Escape),
      expectedFocus: [".cm-content"],
    });
  });
});
