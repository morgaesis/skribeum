// Editor-level integration of the registered features: the slash menu
// (trigger, filter, accept as a declared-range mutation), table cell
// navigation and structure commands through the registry, and the find
// panel with its match count. Views run the same extension set the
// editor component assembles.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { searchPanelOpen } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  BULK_TEXT_INPUT_LENGTH,
  bulkTextInput,
} from "../../src/lib/editor/bulkInput";
import { showInvisibleCharacters } from "../../src/lib/editor/invisibles";
import { obsidianMarkdownExtensions } from "../../src/lib/editor/markdown/obsidian";
import { createAppRegistry } from "../../src/lib/features";
import { findExtension } from "../../src/lib/features/findPanel";
import { selectionToolbar } from "../../src/lib/features/selectionToolbar";
import {
  filteredSlashCommands,
  slashMenu,
  slashMenuOpen,
} from "../../src/lib/features/slashMenu";
import {
  type CommandContext,
  type CommandRegistry,
  editorKeymap,
} from "../../src/lib/registry";

const registry: CommandRegistry = createAppRegistry();

let activeView: EditorView | undefined;

function context(): CommandContext {
  return {
    view: activeView ?? null,
    openNote: () => Promise.resolve(),
    openView: () => {},
    toggleView: () => {},
    closeSurfaces: () => {},
    requestSave: () => {},
    notePaths: () => [],
    recentNotePaths: () => [],
  };
}

function makeView(doc: string, cursor = 0): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensions,
        }),
        editorKeymap(registry, context),
        slashMenu(registry, context),
        selectionToolbar(registry, context),
        findExtension(),
      ],
    }),
    parent: document.body,
  });
  activeView = view;
  return view;
}

function typeText(view: EditorView, text: string): void {
  for (const character of text) {
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: { from: head, to: head, insert: character },
      selection: { anchor: head + 1 },
      userEvent: "input.type",
    });
  }
}

describe("visible whitespace", () => {
  function lineEndCount(doc: string): number {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [showInvisibleCharacters()],
      }),
      parent: document.body,
    });
    activeView = view;
    return view.dom.querySelectorAll(".cm-skr-invisible-line-end").length;
  }

  it("shows only line endings that exist in the document", () => {
    expect(lineEndCount("one\ntwo")).toBe(1);
    activeView?.destroy();
    expect(lineEndCount("one\ntwo\n")).toBe(2);
  });
});

function runEditorCommand(id: string): boolean {
  return registry.run(id, context());
}

afterEach(() => {
  activeView?.destroy();
  activeView = undefined;
});

describe("bulk text input", () => {
  it("applies a large multi-line insertion as one editor transaction", () => {
    const transactions: string[] = [];
    const view = new EditorView({
      state: EditorState.create({
        doc: "start",
        selection: { anchor: 5 },
        extensions: [
          bulkTextInput(),
          EditorView.updateListener.of((update) => {
            for (const transaction of update.transactions) {
              if (transaction.docChanged) {
                transactions.push(
                  transaction.isUserEvent("input.type") ? "type" : "other",
                );
              }
            }
          }),
        ],
      }),
      parent: document.body,
    });
    activeView = view;
    const text = `\n${"bulk input line\n".repeat(BULK_TEXT_INPUT_LENGTH / 8)}`;
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: text,
      inputType: "insertText",
    });

    expect(view.contentDOM.dispatchEvent(event)).toBe(false);
    expect(view.state.doc.toString()).toBe(`start${text}`);
    expect(transactions).toEqual(["type"]);
  });

  it("leaves ordinary typing on the native input path", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "start",
        selection: { anchor: 5 },
        extensions: [bulkTextInput()],
      }),
      parent: document.body,
    });
    activeView = view;
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: " ordinary typing",
      inputType: "insertText",
    });

    expect(view.contentDOM.dispatchEvent(event)).toBe(true);
    expect(view.state.doc.toString()).toBe("start");
  });
});

describe("slash menu", () => {
  it("opens at a line start and after whitespace, not mid-word", () => {
    const midWord = makeView("word", 4);
    typeText(midWord, "/");
    expect(slashMenuOpen(midWord.state)).toBe(false);
    midWord.destroy();

    const lineStart = makeView("", 0);
    typeText(lineStart, "/");
    expect(slashMenuOpen(lineStart.state)).toBe(true);
    lineStart.destroy();

    const afterSpace = makeView("word ", 5);
    typeText(afterSpace, "/");
    expect(slashMenuOpen(afterSpace.state)).toBe(true);
  });

  it("filters registry slash commands as the query grows", () => {
    const view = makeView("", 0);
    typeText(view, "/head");
    expect(slashMenuOpen(view.state)).toBe(true);
    const items = filteredSlashCommands(registry, "head");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.id).toBe("insert.heading-1");
    // Every filtered item is a registered slash command.
    const registered = new Set(
      registry.slashCommands().map((command) => command.id),
    );
    for (const item of items) {
      expect(registered.has(item.id)).toBe(true);
    }
  });

  it("accepts an entry by removing the slash text and running it", () => {
    const view = makeView("", 0);
    typeText(view, "/head");
    expect(runEditorCommand("slash.accept")).toBe(true);
    expect(slashMenuOpen(view.state)).toBe(false);
    // The `/head` range was removed and heading 1 inserted at line start.
    expect(view.state.doc.toString()).toBe("# ");
  });

  it("navigates with the slash.* commands and closes on escape", () => {
    const view = makeView("", 0);
    typeText(view, "/");
    expect(runEditorCommand("slash.next")).toBe(true);
    expect(runEditorCommand("slash.previous")).toBe(true);
    expect(runEditorCommand("slash.close")).toBe(true);
    expect(slashMenuOpen(view.state)).toBe(false);
    // With the menu closed the commands decline, letting the key fall
    // through to stock bindings.
    expect(runEditorCommand("slash.close")).toBe(false);
    expect(runEditorCommand("slash.accept")).toBe(false);
  });

  it("renders an ARIA listbox with the active option marked", () => {
    const view = makeView("", 0);
    typeText(view, "/");
    const listbox = view.dom.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const options = [...(listbox?.querySelectorAll('[role="option"]') ?? [])];
    expect(options.length).toBe(registry.slashCommands().length);
    expect(
      options.filter(
        (option) => option.getAttribute("aria-selected") === "true",
      ),
    ).toHaveLength(1);
  });
});

describe("table editing through the registry", () => {
  const TABLE = "| a | b |\n| --- | --- |\n| c | d |";

  it("moves across cells on the cell navigation commands", () => {
    const view = makeView(TABLE, 2);
    expect(runEditorCommand("table.cell.next")).toBe(true);
    // The cursor landed at the end of cell content "b".
    expect(view.state.doc.sliceString(0, view.state.selection.main.head)).toBe(
      "| a | b",
    );
    expect(runEditorCommand("table.cell.previous")).toBe(true);
    expect(view.state.doc.sliceString(0, view.state.selection.main.head)).toBe(
      "| a",
    );
  });

  it("declines cell navigation outside a table", () => {
    makeView("plain text", 3);
    expect(runEditorCommand("table.cell.next")).toBe(false);
    expect(runEditorCommand("table.cell.previous")).toBe(false);
  });

  it("grows the table when tabbing past the last cell", () => {
    const view = makeView(TABLE, TABLE.length - 2);
    expect(runEditorCommand("table.cell.next")).toBe(true);
    expect(view.state.doc.toString().split("\n")).toHaveLength(4);
  });

  it("inserts rows and columns from the registered commands", () => {
    const view = makeView(TABLE, TABLE.indexOf("c"));
    expect(runEditorCommand("table.row.insert-below")).toBe(true);
    expect(view.state.doc.toString().split("\n")).toHaveLength(4);
    expect(runEditorCommand("table.column.insert-after")).toBe(true);
    const header = view.state.doc.toString().split("\n")[0] ?? "";
    expect(header.split("|").length).toBe(5);
  });
});

describe("in-note find through the registry", () => {
  it("opens the panel, counts matches, and replaces through the buffer", () => {
    const view = makeView("beta beta beta\n", 0);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(runEditorCommand("find.open")).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(true);

    const findInput =
      view.dom.querySelector<HTMLInputElement>(".cm-skr-find-input");
    expect(findInput).not.toBeNull();
    if (findInput === null) {
      return;
    }
    findInput.value = "beta";
    findInput.dispatchEvent(new Event("input"));
    const count = view.dom.querySelector(".cm-skr-find-count");
    expect(count?.textContent).toContain("3");

    // Replace-all dispatches an ordinary transaction over the buffer.
    const inputs = [
      ...view.dom.querySelectorAll<HTMLInputElement>(".cm-skr-find-input"),
    ];
    const replaceInput = inputs[1];
    if (replaceInput !== undefined) {
      replaceInput.value = "gamma";
      replaceInput.dispatchEvent(new Event("input"));
    }
    const replaceAllButton = [
      ...view.dom.querySelectorAll<HTMLButtonElement>(".cm-skr-find-button"),
    ].find((element) => element.getAttribute("aria-label") === "Replace all");
    replaceAllButton?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(view.state.doc.toString()).toBe("gamma gamma gamma\n");

    expect(runEditorCommand("find.close")).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(runEditorCommand("find.close")).toBe(false);
  });
});
