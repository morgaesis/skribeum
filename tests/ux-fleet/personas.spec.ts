import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import { installUxInstrumentation, PersonaSession } from "./signals";
import { FLEET_NOTE_COUNT, FLEET_SEED, NOTES } from "./vault";

const modifier = process.platform === "darwin" ? Key.Command : Key.Ctrl;

before(async () => {
  await browser.tauri.switchWindow("main");
  await browser.setWindowSize(1280, 800);
  await $(`li=${NOTES.start}`).waitForExist({ timeout: 120_000 });
  await installUxInstrumentation();
});

async function openPicker(
  session: PersonaSession,
  intent: string,
  action: string,
  chord: string[],
  label: string,
  finalKey: string,
  surfaceSelector = `[role="combobox"][aria-label="${label}"]`,
  focusSelector = surfaceSelector,
): Promise<void> {
  await session.interact({
    intent,
    action,
    perform: () => browser.keys(chord),
    visible: {
      selector: surfaceSelector,
      text: null,
    },
    trigger: { event: "keydown", key: finalKey },
    latencyKind: "surface",
    expectedFocus: [focusSelector],
  });
}

async function queryPicker(
  session: PersonaSession,
  intent: string,
  query: string,
  expected: string,
): Promise<void> {
  await session.interact({
    intent,
    action: `Type ${JSON.stringify(query)} into the open picker`,
    perform: async () => {
      await $('[role="combobox"]').addValue(query);
    },
    visible: { selector: '[role="option"]', text: expected },
    expectedFocus: ['[role="combobox"]'],
  });
}

async function pickNote(
  session: PersonaSession,
  intent: string,
  action: string,
  expectedContent: string,
): Promise<void> {
  await session.interact({
    intent,
    action,
    perform: () => browser.keys(Key.Enter),
    visible: { selector: ".cm-content", text: expectedContent },
    trigger: { event: "keydown", key: "Enter" },
    latencyKind: "note",
    expectedFocus: [".cm-content"],
  });
}

async function closeOverlay(
  session: PersonaSession,
  intent: string,
  selector = '[role="dialog"]',
): Promise<void> {
  await session.interact({
    intent,
    action: "Press Escape to close the active surface",
    perform: () => browser.keys(Key.Escape),
    visible: { selector, text: null, absent: true },
    expectedFocus: [".cm-content"],
  });
}

async function clickNote(
  session: PersonaSession,
  intent: string,
  name: string,
  expectedContent: string,
): Promise<void> {
  await session.interact({
    intent,
    action: `Click ${name} in the vault tree`,
    perform: async () => {
      await $(`li=${name}`).click();
    },
    visible: { selector: ".cm-content", text: expectedContent },
    trigger: { event: "click", key: null },
    latencyKind: "note",
    expectedFocus: ['[role="treeitem"]'],
  });
}

async function typeIntoEditor(
  session: PersonaSession,
  intent: string,
  action: string,
  text: string,
  visibleText: string,
): Promise<void> {
  await browser.execute(() => {
    document.querySelector<HTMLElement>(".cm-content")?.focus();
  });
  await session.interact({
    intent,
    action,
    perform: async () => {
      await $(".cm-content").addValue(text);
    },
    visible: { selector: ".cm-content", text: visibleText },
    trigger: { event: "beforeinput", key: null },
    latencyKind: "glyph",
    expectedFocus: [".cm-content"],
  });
}

describe("persona-driven UX fleet", () => {
  it("runs the Obsidian migrant session", async () => {
    const session = new PersonaSession(
      "01-obsidian-migrant",
      "Obsidian migrant",
      FLEET_SEED + 1,
    );
    const intent = `Audit a ${FLEET_NOTE_COUNT}-note imported vault and reach deeply nested material`;
    await clickNote(session, intent, "Start Here.md", "Start here");
    await openPicker(
      session,
      intent,
      "Press Ctrl+O to open the quick switcher over the imported vault",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await queryPicker(session, intent, "Deep Note 0199", NOTES.deep);
    await pickNote(
      session,
      intent,
      "Press Enter to open the deeply nested migration note",
      "Deep migration note",
    );
    await openPicker(
      session,
      intent,
      "Press Ctrl+Shift+F to search the imported vault",
      [modifier, Key.Shift, "f"],
      "Search vault",
      "F",
    );
    await queryPicker(session, intent, "fleet-search-token-deep", "Deep");
    await pickNote(
      session,
      intent,
      "Press Enter on the ranked result for the deep note",
      "Deep migration note",
    );
    await openPicker(
      session,
      intent,
      "Open the quick switcher again to revisit a recent note",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await closeOverlay(session, intent);
  });

  it("runs the daily journaler session", async () => {
    const session = new PersonaSession(
      "02-daily-journaler",
      "Daily journaler",
      FLEET_SEED + 2,
    );
    const intent =
      "Capture a daily entry, add links quickly, and move between linked notes";
    await openPicker(
      session,
      intent,
      "Press Ctrl+O to find the pre-created daily note",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await queryPicker(session, intent, "2026-07-31", NOTES.daily);
    await pickNote(
      session,
      intent,
      "Press Enter to open today's journal entry",
      "2026-07-31",
    );
    await typeIntoEditor(
      session,
      intent,
      "Type a new journal heading",
      "\n## Afternoon capture",
      "Afternoon capture",
    );
    await typeIntoEditor(
      session,
      intent,
      "Type a wikilink without pausing",
      "\nLinked [[Daily/2026-07-30]] while writing.",
      "while writing",
    );
    await session.interact({
      intent,
      action: "Press Ctrl+S to save the journal entry",
      perform: () => browser.keys([modifier, "s"]),
      expectedFocus: [".cm-content"],
    });
    await openPicker(
      session,
      intent,
      "Press Ctrl+O to follow the linked journal note",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await queryPicker(session, intent, "2026-07-30", NOTES.linkedDaily);
    await pickNote(
      session,
      intent,
      "Press Enter to open the linked daily note",
      "linked journal entry",
    );
  });

  it("runs the researcher session", async () => {
    const session = new PersonaSession(
      "03-researcher",
      "Researcher with long documents",
      FLEET_SEED + 3,
    );
    const intent =
      "Review a long document, paste evidence, search within it, and edit tables";
    await openPicker(
      session,
      intent,
      "Press Ctrl+O to locate the long research document",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await queryPicker(session, intent, "Long Paper", NOTES.research);
    await pickNote(
      session,
      intent,
      "Press Enter to open the long research document",
      "Long paper",
    );
    const pasted = Array.from(
      { length: 80 },
      (_, index) =>
        `\nEvidence paste ${index}: observed result ${index * 19} with citation [[Deep Note ${String(index).padStart(4, "0")}]].`,
    ).join("");
    await typeIntoEditor(
      session,
      intent,
      "Paste an 80-paragraph evidence extract into the long paper",
      pasted,
      "Evidence paste 79",
    );
    await session.interact({
      intent,
      action: "Press Ctrl+F to open in-note find",
      perform: () => browser.keys([modifier, "f"]),
      visible: { selector: ".cm-skr-find-input", text: null },
      trigger: { event: "keydown", key: "f" },
      latencyKind: "surface",
      expectedFocus: [".cm-skr-find-input"],
    });
    await session.interact({
      intent,
      action: "Search the long paper for Evidence 219",
      perform: async () => {
        await $(".cm-skr-find-input").addValue("Evidence 219");
      },
      visible: { selector: ".cm-skr-find-count", text: "1" },
      expectedFocus: [".cm-skr-find-input"],
    });
    await closeOverlay(session, intent, ".cm-skr-find-panel");
    await openPicker(
      session,
      intent,
      "Press Ctrl+P to open the command palette",
      [modifier, "p"],
      "Command palette",
      "p",
    );
    await queryPicker(session, intent, "insert table", "Table");
    await session.interact({
      intent,
      action: "Press Enter to insert a table through the command registry",
      perform: () => browser.keys(Key.Enter),
      visible: { selector: ".cm-content", text: "Column 1" },
      trigger: { event: "keydown", key: "Enter" },
      latencyKind: "glyph",
      expectedFocus: [".cm-content"],
    });
    await session.interact({
      intent,
      action: "Press End to move through the long document",
      perform: () => browser.keys(Key.End),
      expectedFocus: [".cm-content"],
      scrollExpected: true,
    });
  });

  it("runs the keyboard-only power-user session", async () => {
    const session = new PersonaSession(
      "04-keyboard-power-user",
      "Keyboard-only power user",
      FLEET_SEED + 4,
    );
    const intent =
      "Navigate every core command surface without pointer input and preserve a useful focus target";
    await openPicker(
      session,
      intent,
      "Press Ctrl+O to open the quick switcher",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await queryPicker(session, intent, "Command Surface", NOTES.keyboard);
    await pickNote(
      session,
      intent,
      "Press Enter to open the command-surface note",
      "Command surface",
    );
    await openPicker(
      session,
      intent,
      "Press Ctrl+P to open the command palette",
      [modifier, "p"],
      "Command palette",
      "p",
    );
    await queryPicker(session, intent, "toggle outline", "outline");
    await session.interact({
      intent,
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
    await session.interact({
      intent,
      action: "Press Tab from the editor toward the outline",
      perform: () => browser.keys(Key.Tab),
      expectedFocus: ['[role="tree"][aria-label="Outline"] [role="treeitem"]'],
      custom: async () => ({ nativeTabTraversal: false }),
    });
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(
          '[role="tree"][aria-label="Outline"] [role="treeitem"]',
        )
        ?.focus();
    });
    await session.interact({
      intent,
      action: "Press Enter on the focused outline heading",
      perform: () => browser.keys(Key.Enter),
      expectedFocus: [".cm-content"],
      scrollExpected: true,
    });
    await session.interact({
      intent,
      action: "Press Ctrl+Shift+O to close the outline panel",
      perform: () => browser.keys([modifier, Key.Shift, "o"]),
      visible: {
        selector: '[role="tree"][aria-label="Outline"]',
        text: null,
        absent: true,
      },
      expectedFocus: [".cm-content"],
    });
    await openPicker(
      session,
      intent,
      "Press Ctrl+, to open settings",
      [modifier, ","],
      "Settings",
      ",",
      '[data-testid="settings-view"]',
      '[data-testid="settings-theme"]',
    );
    await closeOverlay(session, intent, '[data-testid="settings-view"]');
  });

  it("runs the low-vision session", async () => {
    const session = new PersonaSession(
      "05-low-vision",
      "Low-vision user",
      FLEET_SEED + 5,
    );
    const intent =
      "Use dark theme at 200 percent page zoom without clipping navigation or losing focus";
    await openPicker(
      session,
      intent,
      "Press Ctrl+, to open visual settings",
      [modifier, ","],
      "Settings",
      ",",
      '[data-testid="settings-view"]',
      '[data-testid="settings-theme"]',
    );
    await session.interact({
      intent,
      action: "Choose the dark theme through the settings binding",
      perform: () =>
        browser.execute(() => {
          const select = document.querySelector<HTMLSelectElement>(
            '[data-testid="settings-theme"]',
          );
          if (select !== null) {
            select.value = "dark";
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }),
      expectedFocus: ['[data-testid="settings-theme"]'],
    });
    await closeOverlay(session, intent, '[data-testid="settings-view"]');
    await session.interact({
      intent,
      action: "Apply a 200 percent WebView page zoom approximation",
      perform: () =>
        browser.execute(() => {
          document.documentElement.style.zoom = "2";
        }),
      expectedFocus: [".cm-content"],
      custom: () =>
        browser.execute(() => ({
          viewportWidth: document.documentElement.clientWidth,
          contentWidth: document.documentElement.scrollWidth,
          horizontalOverflowPx: Math.max(
            0,
            document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        })),
    });
    await openPicker(
      session,
      intent,
      "Press Ctrl+P while the page is enlarged",
      [modifier, "p"],
      "Command palette",
      "p",
    );
    await closeOverlay(session, intent);
    await session.interact({
      intent,
      action: "Reset the WebView zoom after the low-vision session",
      perform: () =>
        browser.execute(() => {
          document.documentElement.style.zoom = "";
        }),
      expectedFocus: [".cm-content"],
    });
  });

  it("runs the interruption-prone session", async () => {
    const session = new PersonaSession(
      "06-interruption-prone",
      "Interruption-prone user",
      FLEET_SEED + 6,
    );
    const intent =
      "Switch notes during edits and dismiss transient surfaces at unpredictable points";
    await openPicker(
      session,
      intent,
      "Press Ctrl+O to locate the unfinished draft",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await queryPicker(session, intent, "Interrupted draft", NOTES.interruption);
    await pickNote(
      session,
      intent,
      "Press Enter to open the unfinished draft",
      "Interrupted draft",
    );
    await typeIntoEditor(
      session,
      intent,
      "Type a short burst into the unfinished draft",
      " before an interruption",
      "before an interruption",
    );
    await openPicker(
      session,
      intent,
      "Open the command palette in the middle of editing",
      [modifier, "p"],
      "Command palette",
      "p",
    );
    await closeOverlay(session, intent);
    await openPicker(
      session,
      intent,
      "Open the quick switcher before the idle save settles",
      [modifier, "o"],
      "Quick switcher",
      "o",
    );
    await queryPicker(session, intent, "Reference", NOTES.interruptionTarget);
    await pickNote(
      session,
      intent,
      "Press Enter to switch away from the edited draft",
      "Reference during interruption",
    );
    await openPicker(
      session,
      intent,
      "Open settings immediately after the note switch",
      [modifier, ","],
      "Settings",
      ",",
      '[data-testid="settings-view"]',
      '[data-testid="settings-theme"]',
    );
    await closeOverlay(session, intent, '[data-testid="settings-view"]');
    await session.interact({
      intent,
      action: "Press Escape again with no transient surface open",
      perform: () => browser.keys(Key.Escape),
      expectedFocus: [".cm-content"],
    });
  });
});
