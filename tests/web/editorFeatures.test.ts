// Editor-level integration of the registered features: the slash menu
// (trigger, filter, accept as a declared-range mutation), table cell
// navigation and structure commands through the registry, and the find
// panel with its match count. Views run the same extension set the
// editor component assembles.

import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { searchPanelOpen } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  BULK_TEXT_INPUT_LENGTH,
  bulkTextInput,
} from "../../src/lib/editor/bulkInput";
import {
  decorationEngine,
  focusRenderedTableCell,
} from "../../src/lib/editor/decorations/engine";
import { showInvisibleCharacters } from "../../src/lib/editor/invisibles";
import { obsidianMarkdownExtensions } from "../../src/lib/editor/markdown/obsidian";
import { createAppRegistry } from "../../src/lib/features";
import { findExtension } from "../../src/lib/features/findPanel";
import {
  selectionToolbar,
  toolbarPlacement,
} from "../../src/lib/features/selectionToolbar";
import {
  filteredSlashCommands,
  slashMenu,
  slashMenuOpen,
} from "../../src/lib/features/slashMenu";
import { tableEditingExtension } from "../../src/lib/features/tableEditing";
import {
  filteredTagCompletions,
  type TagCatalogEntry,
  tagAffordances,
  tagCompletionOpen,
} from "../../src/lib/features/tags";
import {
  type CommandContext,
  type CommandRegistry,
  editorKeymap,
  globalKeydownHandler,
} from "../../src/lib/registry";

const registry: CommandRegistry = createAppRegistry();

let activeView: EditorView | undefined;
let tagCatalog: TagCatalogEntry[] = [];
let recentTags: string[] = [];
let searchedTags: string[] = [];
let rememberedTags: string[] = [];
let followLinkCalls = 0;

const tagOptions = () => ({
  catalog: () => tagCatalog,
  recentTags: () => recentTags,
  search: (tag: string) => searchedTags.push(tag),
  remember: (tag: string) => rememberedTags.push(tag),
});

function context(): CommandContext {
  return {
    view: activeView ?? null,
    openNote: () => Promise.resolve(),
    openView: () => {},
    openCommandSurface: () => {},
    toggleView: () => {},
    closeSurfaces: () => {},
    requestSave: () => {},
    notePaths: () => [],
    recentNotePaths: () => [],
    navigateBack: () => false,
    navigateForward: () => false,
    followLink: () => {
      followLinkCalls += 1;
      return false;
    },
  };
}

function makeView(
  doc: string,
  cursor = 0,
  extensions: readonly Extension[] = [],
): EditorView {
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
        tagAffordances(tagOptions),
        slashMenu(registry, context),
        selectionToolbar(registry, context),
        findExtension(),
        ...extensions,
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

function pressEditorKey(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

describe("task marker editing", () => {
  it.each([
    ["Task", "- [ ] Task", "- [ ] Task\n- [ ] "],
    ["Time", "- [D] Time", "- [D] Time\n- [D] "],
    ["Importance", "- [!] Importance", "- [!] Importance\n- [!] "],
    ["Reference", "- [b] Reference", "- [b] Reference\n- [b] "],
  ])("inherits the %s track on newline", (_track, source, expected) => {
    const view = makeView(source, source.length);
    pressEditorKey(view, "Enter");
    expect(view.state.doc.toString()).toBe(expected);
  });

  it("removes an untouched inherited marker with one Backspace", () => {
    const source = "- [ ] Task";
    const view = makeView(source, source.length);
    pressEditorKey(view, "Enter");
    view.dispatch({
      selection: { anchor: view.state.selection.main.head },
      userEvent: "select.pointer",
    });
    pressEditorKey(view, "Backspace");
    expect(view.state.doc.toString()).toBe(`${source}\n`);
    expect(view.state.doc.line(2).text).toBe("");
  });

  it("reveals and deletes a task marker one source character at a time", () => {
    const source = "- [ ] task";
    const view = makeView(source, source.indexOf("task"));
    const documents: string[] = [];
    for (let press = 0; press < 6; press += 1) {
      pressEditorKey(view, "Backspace");
      documents.push(view.state.doc.toString());
      if (press < 5) {
        view.dispatch({
          selection: { anchor: view.state.selection.main.head },
          userEvent: "select.pointer",
        });
      }
    }
    expect(documents).toEqual([
      "- [ ]task",
      "- [ task",
      "- [task",
      "- task",
      "-task",
      "task",
    ]);
  });

  it("deletes forward into a revealed task marker one character at a time", () => {
    const source = "- [ ] task";
    const view = makeView(source, source.indexOf("["));
    const documents: string[] = [];
    for (let press = 0; press < 4; press += 1) {
      pressEditorKey(view, "Delete");
      documents.push(view.state.doc.toString());
    }
    expect(documents).toEqual(["-  ] task", "- ] task", "-  task", "- task"]);
  });
});

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
  tagCatalog = [];
  recentTags = [];
  searchedTags = [];
  rememberedTags = [];
  followLinkCalls = 0;
});

describe("persistent history keymap", () => {
  it("routes the macOS redo chord before the unshifted undo fallback", () => {
    let undoCalls = 0;
    let redoCalls = 0;
    // The chord is the platform's: the keymap resolves Mod against the
    // platform it is built on, so the macOS chord is asserted on macOS.
    const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const view = new EditorView({
      state: EditorState.create({
        doc: "edited",
        extensions: [
          editorKeymap(registry, context, {
            undo: () => {
              undoCalls += 1;
              return true;
            },
            redo: () => {
              redoCalls += 1;
              return true;
            },
          }),
        ],
      }),
      parent: document.body,
    });
    activeView = view;
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyZ",
      key: "z",
      metaKey: true,
      shiftKey: true,
    });

    expect(view.contentDOM.dispatchEvent(event)).toBe(false);
    expect(redoCalls).toBe(1);
    expect(undoCalls).toBe(0);

    if (platform === undefined) {
      Reflect.deleteProperty(navigator, "platform");
    } else {
      Object.defineProperty(navigator, "platform", platform);
    }
  });

  it("leaves the macOS redo chord to the platform that has it", () => {
    let undoCalls = 0;
    let redoCalls = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: "edited",
        extensions: [
          editorKeymap(registry, context, {
            undo: () => {
              undoCalls += 1;
              return true;
            },
            redo: () => {
              redoCalls += 1;
              return true;
            },
          }),
        ],
      }),
      parent: document.body,
    });
    activeView = view;
    // Meta is not the primary modifier here, so this chord is nobody's: it
    // must not fall through to undo either.
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyZ",
        key: "z",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(redoCalls).toBe(0);
    expect(undoCalls).toBe(0);

    // The platform's own redo chord runs.
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyZ",
        key: "z",
        ctrlKey: true,
        shiftKey: true,
      }),
    );
    expect(redoCalls).toBe(1);
    expect(undoCalls).toBe(0);
  });
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

  it("leaves nothing of the trigger behind on any slash entry", () => {
    let previous: EditorView | undefined;
    for (const command of registry.slashCommands()) {
      previous?.destroy();
      const view = makeView("Body text.\n\n", 12);
      previous = view;
      typeText(view, "/");
      const items = filteredSlashCommands(registry, "");
      const index = items.findIndex((entry) => entry.id === command.id);
      for (let step = 0; step < index; step += 1) {
        runEditorCommand("slash.next");
      }
      expect(runEditorCommand("slash.accept")).toBe(true);
      expect(view.state.doc.toString(), command.id).not.toContain("/");
    }
  });

  it("replaces the trigger with the insertion in one undoable step", () => {
    const view = makeView("", 0, [history()]);
    typeText(view, "/task");
    expect(runEditorCommand("slash.accept")).toBe(true);
    // What the person types next is the task's text, not text in front of
    // a marker that the caret was left behind.
    typeText(view, "Buy milk");
    expect(view.state.doc.toString()).toBe("- [ ] Buy milk");
    view.destroy();

    // One step back over the acceptance restores the whole trigger. Were
    // the removal and the insertion two transactions, this step would
    // reveal the document between them, with the trigger already gone.
    const undone = makeView("", 0, [history()]);
    typeText(undone, "/task");
    expect(runEditorCommand("slash.accept")).toBe(true);
    expect(undo(undone)).toBe(true);
    expect(undone.state.doc.toString()).toBe("/task");
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

describe("block authoring commands", () => {
  /**
   * The observation that matters: run the command, type one character,
   * read the document. A caret left in front of the marker it inserted
   * produces a line that is not the construct that was asked for, and
   * only typing shows it.
   */
  function afterTyping(
    commandId: string,
    document: string,
    cursor: number,
    typed = "X",
  ): string {
    const view = makeView(document, cursor);
    expect(runEditorCommand(commandId)).toBe(true);
    typeText(view, typed);
    return view.state.doc.toString();
  }

  it.each([
    ["insert.heading-1", "# X"],
    ["insert.heading-2", "## X"],
    ["insert.heading-3", "### X"],
    ["insert.task", "- [ ] X"],
    ["insert.bullet-list", "- X"],
    ["insert.numbered-list", "1. X"],
    ["insert.callout", "> [!note] X"],
  ])("puts what is typed after %s inside the construct", (id, expected) => {
    expect(afterTyping(id, "", 0)).toBe(expected);
  });

  it("keeps the caret in the text when the line already has some", () => {
    // The caret sits on `f`; the marker arrives in front of the text and
    // the caret travels with the text rather than staying at the offset.
    expect(afterTyping("insert.task", "first bullet", 0)).toBe(
      "- [ ] Xfirst bullet",
    );
    expect(afterTyping("insert.heading-2", "first bullet", 5)).toBe(
      "## firstX bullet",
    );
    // A caret inside the marker being replaced belongs to the marker, and
    // lands at the end of whatever replaces it, however much shorter.
    expect(afterTyping("insert.bullet-list", "### Title", 2)).toBe("- XTitle");
  });

  it("turns a list line into a heading rather than a mixed line", () => {
    const view = makeView("- first bullet", 2);
    expect(runEditorCommand("insert.heading-2")).toBe(true);
    expect(view.state.doc.toString()).toBe("## first bullet");
    typeText(view, "X");
    expect(view.state.doc.toString()).toBe("## Xfirst bullet");
  });

  it.each([
    ["insert.task", "- [ ] one\n- [ ] two\n- [ ] three"],
    ["insert.bullet-list", "- one\n- two\n- three"],
    ["insert.numbered-list", "1. one\n2. two\n3. three"],
    ["insert.heading-2", "## one\n## two\n## three"],
  ])("applies %s to every line of the selection", (id, expected) => {
    const source = "one\ntwo\nthree";
    const view = makeView(source, 0);
    view.dispatch({ selection: { anchor: 0, head: source.length } });
    expect(runEditorCommand(id)).toBe(true);
    expect(view.state.doc.toString()).toBe(expected);
    // The selection still holds the text it held, so typing over it
    // replaces what the person had highlighted and nothing else, and a
    // second run reverses the first.
    const range = view.state.selection.main;
    expect(view.state.doc.sliceString(range.from, range.to)).toBe(
      expected.slice(expected.indexOf("one"), expected.length),
    );
    expect(runEditorCommand(id)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("wraps every selected line in a callout and waits on its title", () => {
    const source = "Para A\nPara B\nPara C";
    const view = makeView(source, 0);
    view.dispatch({ selection: { anchor: 0, head: source.length } });
    expect(runEditorCommand("insert.callout")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "> [!note] \n> Para A\n> Para B\n> Para C",
    );
    typeText(view, "Careful");
    expect(view.state.doc.toString()).toBe(
      "> [!note] Careful\n> Para A\n> Para B\n> Para C",
    );
  });

  it("moves heading levels and declines away from a heading", () => {
    const view = makeView("## Section", 4);
    expect(runEditorCommand("heading.decrease-level")).toBe(true);
    expect(view.state.doc.toString()).toBe("# Section");
    expect(runEditorCommand("heading.increase-level")).toBe(true);
    expect(runEditorCommand("heading.increase-level")).toBe(true);
    expect(view.state.doc.toString()).toBe("### Section");
    typeText(view, "X");
    expect(view.state.doc.toString()).toBe("### SXection");
    view.destroy();

    const paragraph = makeView("just text", 2);
    expect(runEditorCommand("heading.increase-level")).toBe(false);
    expect(paragraph.state.doc.toString()).toBe("just text");
  });

  it("nests a list line by one step and declines off a list", () => {
    const view = makeView("- one\n- two", 9);
    expect(runEditorCommand("list.indent")).toBe(true);
    expect(view.state.doc.toString()).toBe("- one\n  - two");
    typeText(view, "X");
    expect(view.state.doc.toString()).toBe("- one\n  - tXwo");
    expect(runEditorCommand("list.outdent")).toBe(true);
    expect(view.state.doc.toString()).toBe("- one\n- tXwo");
    view.destroy();

    const paragraph = makeView("just text", 2);
    expect(runEditorCommand("list.indent")).toBe(false);
    expect(runEditorCommand("list.outdent")).toBe(false);
    expect(paragraph.state.doc.toString()).toBe("just text");
  });

  it("nests a list line from the keyboard through the registry binding", () => {
    const view = makeView("- one\n- two", 8);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "]",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe("- one\n  - two");
  });

  it("leaves a snippet's caret inside the snippet", () => {
    const view = makeView("", 0);
    expect(runEditorCommand("insert.code-fence")).toBe(true);
    typeText(view, "print()");
    expect(view.state.doc.toString()).toBe("```\nprint()\n```");
  });

  it("declines every authoring command in a read-only note", () => {
    const view = makeView("text", 0, [EditorState.readOnly.of(true)]);
    for (const id of [
      "insert.heading-1",
      "insert.task",
      "insert.bullet-list",
      "insert.numbered-list",
      "insert.callout",
      "insert.code-fence",
      "heading.increase-level",
      "list.indent",
    ]) {
      expect(runEditorCommand(id)).toBe(false);
    }
    expect(view.state.doc.toString()).toBe("text");
  });
});

describe("tag affordances", () => {
  it("offers the typed tag itself and commits it on Enter", () => {
    tagCatalog = [
      { tag: "features", noteCount: 9, occurrenceCount: 9 },
      { tag: "feature/ui", noteCount: 5, occurrenceCount: 5 },
      { tag: "feature", noteCount: 3, occurrenceCount: 3 },
      { tag: "feature/api", noteCount: 2, occurrenceCount: 2 },
    ];
    const view = makeView("", 0);

    typeText(view, "#feature");

    const options = [
      ...(view.dom.querySelectorAll('.cm-skr-tag-menu [role="option"]') ?? []),
    ];
    expect(options[0]?.textContent).toBe("#feature");
    expect(
      view.dom.querySelector('.cm-skr-tag-menu [aria-selected="true"]')
        ?.textContent,
    ).toBe("#feature");

    pressEditorKey(view, "Enter");

    expect(view.state.doc.toString()).toBe("#feature");
  });

  it("ranks by band, then session recency, then how many notes use the tag", () => {
    const catalog = [
      { tag: "rare", noteCount: 1, occurrenceCount: 1 },
      { tag: "notes", noteCount: 4, occurrenceCount: 4 },
      { tag: "occurrence", noteCount: 3, occurrenceCount: 100 },
      { tag: "beta", noteCount: 3, occurrenceCount: 10 },
      { tag: "alpha", noteCount: 3, occurrenceCount: 10 },
    ];

    // Nothing typed: recency first, then the tags most notes use. A tag
    // written a hundred times in three notes does not outrank a tag written
    // once in each of four.
    expect(
      filteredTagCompletions(catalog, ["rare"], "").map((item) => item.tag),
    ).toEqual(["rare", "notes", "alpha", "beta", "occurrence"]);

    // Only characters that actually start the tag or one of its path
    // segments count, so "aa" no longer reaches "alpha" by skipping.
    expect(
      filteredTagCompletions(
        [
          { tag: "alpha", noteCount: 20, occurrenceCount: 40 },
          { tag: "aardvark", noteCount: 1, occurrenceCount: 1 },
          { tag: "missing", noteCount: 100, occurrenceCount: 100 },
        ],
        ["alpha"],
        "aa",
      ).map((item) => item.tag),
    ).toEqual(["aardvark"]);

    // The tag the reader typed is present and leads, ahead of the deeper
    // path that merely carries it as a segment.
    expect(
      filteredTagCompletions(
        [
          { tag: "ced", noteCount: 1, occurrenceCount: 1 },
          { tag: "project/cedar-room", noteCount: 9, occurrenceCount: 9 },
        ],
        [],
        "ced",
      ).map((item) => item.tag),
    ).toEqual(["ced", "project/cedar-room"]);
  });

  it("filters while typing and exposes a keyboard-operated listbox", () => {
    tagCatalog = [
      { tag: "project/alpha", noteCount: 4, occurrenceCount: 8 },
      { tag: "personal", noteCount: 3, occurrenceCount: 3 },
      { tag: "archive", noteCount: 2, occurrenceCount: 2 },
    ];
    const view = makeView("", 0);

    typeText(view, "#p");

    expect(tagCompletionOpen(view.state)).toBe(true);
    const listbox = view.dom.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-label")).toBe("Tag suggestions");
    expect(
      [...(listbox?.querySelectorAll('[role="option"]') ?? [])].map(
        (option) => option.textContent,
      ),
    ).toEqual(["#project/alpha", "#personal"]);
  });

  it.each([
    ["Enter", false, "#alpha", "alpha"],
    ["Control and Enter", true, "#beta", "beta"],
  ])("accepts with %s", (_label, control, expected, tag) => {
    tagCatalog = [
      { tag: "alpha", noteCount: 2, occurrenceCount: 3 },
      { tag: "beta", noteCount: 1, occurrenceCount: 1 },
    ];
    const view = makeView("", 0);
    typeText(view, `#${tag.slice(0, 2)}`);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      ctrlKey: control,
      bubbles: true,
      cancelable: true,
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(expected);
    expect(tagCompletionOpen(view.state)).toBe(false);
    expect(rememberedTags).toEqual([tag]);
    expect(followLinkCalls).toBe(0);
  });

  it("ignores the live query when the catalog refreshes before navigation", () => {
    tagCatalog = [
      { tag: "project/cedar-room", noteCount: 2, occurrenceCount: 2 },
      { tag: "context/outdoors", noteCount: 1, occurrenceCount: 1 },
    ];
    const view = makeView("", 0);
    typeText(view, "#ced");

    tagCatalog = [
      { tag: "ced", noteCount: 1, occurrenceCount: 1 },
      ...tagCatalog,
    ];
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        code: "ArrowDown",
        keyCode: 40,
        bubbles: true,
        cancelable: true,
      }),
    );

    // The refreshed catalog contributes an exact match, so the row one below
    // it is the one the arrow key lands on and the one Enter commits.
    expect(view.dom.querySelector('[aria-selected="true"]')?.textContent).toBe(
      "#project/cedar-room",
    );
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe("#project/cedar-room");
  });

  it("leaves Enter to normal editing when no completion matches", () => {
    tagCatalog = [{ tag: "alpha", noteCount: 1, occurrenceCount: 1 }];
    const view = makeView("", 0);
    typeText(view, "#missing");
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("#missing\n");
    expect(tagCompletionOpen(view.state)).toBe(false);
    // The caret sits exactly where typing just landed it, so the
    // follow-link-on-Enter command declines before ever calling
    // followLink: a bare Enter reaching a link only by typing proximity
    // keeps its default meaning as a paragraph break.
    expect(followLinkCalls).toBe(0);
  });

  it("bounds the rendered completion candidates", () => {
    tagCatalog = Array.from({ length: 150 }, (_, index) => ({
      tag: `tag-${index.toString().padStart(3, "0")}`,
      noteCount: 1,
      occurrenceCount: 1,
    }));
    const view = makeView("", 0);

    typeText(view, "#tag");

    // A caret-anchored menu whose tail cannot be read is a menu whose tail
    // should not be built.
    expect(
      view.dom.querySelectorAll('.cm-skr-tag-menu [role="option"]'),
    ).toHaveLength(8);
  });

  it("keeps the last row selected when Down is pressed on it", () => {
    tagCatalog = [
      { tag: "tag/one", noteCount: 3, occurrenceCount: 3 },
      { tag: "tag/two", noteCount: 2, occurrenceCount: 2 },
    ];
    const view = makeView("", 0);
    typeText(view, "#tag");

    for (let press = 0; press < 5; press += 1) {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          keyCode: 40,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    expect(view.dom.querySelector('[aria-selected="true"]')?.textContent).toBe(
      "#tag/two",
    );
  });

  it("keeps the menu on a wildcard and reopens it when one is deleted", () => {
    tagCatalog = [
      { tag: "feature", noteCount: 3, occurrenceCount: 3 },
      { tag: "feature/ui", noteCount: 2, occurrenceCount: 2 },
    ];
    const view = makeView("", 0);

    typeText(view, "#feature");
    const withoutStar = [
      ...view.dom.querySelectorAll('.cm-skr-tag-menu [role="option"]'),
    ].map((option) => option.textContent);

    typeText(view, "*");

    expect(tagCompletionOpen(view.state)).toBe(true);
    expect(
      [...view.dom.querySelectorAll('.cm-skr-tag-menu [role="option"]')].map(
        (option) => option.textContent,
      ),
    ).toEqual(withoutStar);

    // A character a tag cannot contain closes the menu; deleting it back out
    // reopens it rather than requiring the hash to be retyped.
    typeText(view, ".");
    expect(tagCompletionOpen(view.state)).toBe(false);
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: { from: head - 1, to: head },
      selection: { anchor: head - 1 },
      userEvent: "delete.backward",
    });

    expect(tagCompletionOpen(view.state)).toBe(true);
    expect(
      [...view.dom.querySelectorAll('.cm-skr-tag-menu [role="option"]')].map(
        (option) => option.textContent,
      ),
    ).toEqual(withoutStar);
  });

  it("never offers a tag that is only a typo away", () => {
    tagCatalog = [
      { tag: "feature", noteCount: 9, occurrenceCount: 9 },
      { tag: "feature/long-document", noteCount: 1, occurrenceCount: 1 },
    ];
    const view = makeView("", 0);

    typeText(view, "#featrue");

    expect(
      [...view.dom.querySelectorAll('.cm-skr-tag-menu [role="option"]')].map(
        (option) => option.textContent,
      ),
    ).toEqual([]);
  });

  // The catalog the packaged end-to-end suite's scratch vault produces, read
  // back from the index rather than assumed: zz-tag-completion-catalog.md
  // writes #project/cedar-room twice and #context/outdoors once, the two
  // navigation notes write #shared, and zz-tag-delete.md writes
  // #delete-only. Keeping the same expectations here means an ordering
  // regression shows up without a packaged build.
  describe("the end-to-end vault's tag catalog", () => {
    const CATALOG: TagCatalogEntry[] = [
      { tag: "project/cedar-room", noteCount: 1, occurrenceCount: 2 },
      { tag: "shared", noteCount: 2, occurrenceCount: 2 },
      { tag: "cedar-notes", noteCount: 1, occurrenceCount: 1 },
      { tag: "context/outdoors", noteCount: 1, occurrenceCount: 1 },
      { tag: "delete-only", noteCount: 1, occurrenceCount: 1 },
    ];

    it("answers ced with the whole-tag match before the segment match", () => {
      // cedar-notes starts with the query outright; project/cedar-room only
      // does so from its second path segment, which is the weaker answer.
      // The one note using cedar-notes against the two occurrences of
      // project/cedar-room does not enter into it.
      expect(
        filteredTagCompletions(CATALOG, [], "ced").map((row) => `#${row.tag}`),
      ).toEqual(["#cedar-notes", "#project/cedar-room"]);
    });

    it("answers context with the one tag below it", () => {
      // context/outdoors is a descendant of the query. Nothing else in the
      // vault starts with it or comes within an edit of it.
      expect(
        filteredTagCompletions(CATALOG, [], "context").map(
          (row) => `#${row.tag}`,
        ),
      ).toEqual(["#context/outdoors"]);
    });

    it("puts the tag accepted most recently above one used as widely", () => {
      // Both tags sit in two notes once each has been accepted into the
      // note being edited, so note count cannot separate them and the
      // alphabet favours context/outdoors. Only recency can reverse that.
      const accepted: TagCatalogEntry[] = [
        { tag: "project/cedar-room", noteCount: 2, occurrenceCount: 3 },
        { tag: "context/outdoors", noteCount: 2, occurrenceCount: 2 },
        { tag: "shared", noteCount: 2, occurrenceCount: 2 },
        { tag: "cedar-notes", noteCount: 1, occurrenceCount: 1 },
        { tag: "delete-only", noteCount: 1, occurrenceCount: 1 },
      ];
      expect(
        filteredTagCompletions(accepted, [], "").map((row) => `#${row.tag}`),
      ).toEqual([
        "#context/outdoors",
        "#project/cedar-room",
        "#shared",
        "#cedar-notes",
        "#delete-only",
      ]);
      expect(
        filteredTagCompletions(
          accepted,
          ["project/cedar-room", "context/outdoors"],
          "",
        ).map((row) => `#${row.tag}`),
      ).toEqual([
        "#project/cedar-room",
        "#context/outdoors",
        "#shared",
        "#cedar-notes",
        "#delete-only",
      ]);
    });
  });

  it("answers from the catalog it had when the last key was pressed", () => {
    // The menu is drawn by the editor's update cycle. A catalog that changes
    // with no editing in between -- which is what an autosave of the
    // half-typed word produces -- does not redraw it, and the next keystroke
    // does. A test that waits for a catalog change to appear in an open menu
    // is therefore waiting for something that will not happen until it types
    // again.
    tagCatalog = [
      { tag: "project/cedar-room", noteCount: 1, occurrenceCount: 2 },
    ];
    const view = makeView("", 0);
    typeText(view, "#ced");
    const rows = () =>
      [...view.dom.querySelectorAll('.cm-skr-tag-menu [role="option"]')].map(
        (option) => option.textContent,
      );
    expect(rows()).toEqual(["#project/cedar-room"]);

    tagCatalog = [
      ...tagCatalog,
      { tag: "ced", noteCount: 1, occurrenceCount: 1 },
    ];

    expect(rows()).toEqual(["#project/cedar-room"]);
    view.dispatch({ selection: { anchor: view.state.selection.main.head } });
    expect(rows()).toEqual(["#ced", "#project/cedar-room"]);
  });

  it("removes the trigger and query when dismissed with Escape", () => {
    tagCatalog = [{ tag: "alpha", noteCount: 1, occurrenceCount: 1 }];
    const view = makeView("Before ", 7);
    typeText(view, "#alp");
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("Before ");
    expect(tagCompletionOpen(view.state)).toBe(false);
    expect(rememberedTags).toEqual([]);
  });

  it("accepts a completion from a touch pointer", () => {
    tagCatalog = [{ tag: "touch", noteCount: 1, occurrenceCount: 1 }];
    const view = makeView("", 0);
    typeText(view, "#");
    const option = view.dom.querySelector<HTMLElement>(
      '.cm-skr-tag-menu [role="option"]',
    );
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    option?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("#touch");
    expect(rememberedTags).toEqual(["touch"]);
  });

  it("opens tag search by pointer and by the registered cursor command", () => {
    const doc = "Read #topic here";
    const view = makeView(doc, doc.indexOf("topic") + 2, [decorationEngine()]);
    const renderedTag = view.dom.querySelector<HTMLElement>(
      '.cm-skr-tag[data-tag="topic"]',
    );
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    renderedTag?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(searchedTags).toEqual(["topic"]);

    expect(runEditorCommand("tag.search-under-cursor")).toBe(true);
    expect(searchedTags).toEqual(["topic", "topic"]);
    expect(registry.command("tag.search-under-cursor")?.palette).not.toBe(
      false,
    );
  });
});

describe("table editing through the registry", () => {
  it("keeps every explicit table command reachable from the slash menu", () => {
    expect(
      filteredSlashCommands(registry, "table").map((command) => command.id),
    ).toEqual(
      expect.arrayContaining([
        "table.row.insert-above",
        "table.row.insert-below",
        "table.column.insert-before",
        "table.column.insert-after",
        "table.row.delete",
        "table.column.delete",
        "table.edit-source",
      ]),
    );
  });

  const TABLE = "| a | b |\n| --- | --- |\n| c | d |";

  it("moves across cells on the cell navigation commands", () => {
    const view = makeView(TABLE, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(runEditorCommand("table.cell.next")).toBe(true);
    expect(view.state.selection.main.head).toBe(0);
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("0");
    expect(runEditorCommand("table.cell.next")).toBe(true);
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("1");
    expect(runEditorCommand("table.cell.previous")).toBe(true);
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("0");
  });

  it("keeps a mid-typed trailing space in the active cell across the document round trip", async () => {
    const view = makeView(TABLE, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(focusRenderedTableCell(view, 0, 1, 0, "end")).toBe(true);
    const nestedFor = () => {
      const editor = view.dom.querySelector<HTMLElement>(
        '.cm-skr-table-cell[data-editing="true"] .cm-editor',
      );
      return editor === null ? null : EditorView.findFromDOM(editor);
    };
    const typeIntoCell = (text: string) => {
      const nested = nestedFor();
      expect(nested).not.toBeNull();
      if (nested === null) return;
      const head = nested.state.selection.main.head;
      nested.dispatch({
        changes: { from: head, insert: text },
        selection: { anchor: head + text.length },
        userEvent: "input.type",
      });
    };

    // Each keystroke round-trips through the document, where a trailing
    // space parses as column padding; the widget update between keystrokes
    // must not strip it out of the nested editor.
    typeIntoCell(" ");
    await new Promise((resolve) => setTimeout(resolve, 10));
    typeIntoCell("x");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(nestedFor()?.state.doc.toString()).toBe("c x");
    // The document keeps the typed trailing space; it parses as padding.
    expect(view.state.doc.toString()).toContain("| c x ");
  });

  it("declines cell navigation outside a table", () => {
    makeView("plain text", 3);
    expect(runEditorCommand("table.cell.next")).toBe(false);
    expect(runEditorCommand("table.cell.previous")).toBe(false);
  });

  it("grows the table when tabbing past the last cell", () => {
    const view = makeView(TABLE, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(focusRenderedTableCell(view, 0, 1, 1, "end")).toBe(true);
    expect(runEditorCommand("table.cell.next")).toBe(true);
    expect(view.state.doc.toString().split("\n")).toHaveLength(4);
  });

  it("tabs from the last rendered cell into the first cell of a new row", async () => {
    const source = `${TABLE}\n\nafter`;
    const view = makeView(source, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(focusRenderedTableCell(view, 0, 1, 1, "end")).toBe(true);
    const nestedEditor = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    const nested =
      nestedEditor === null ? null : EditorView.findFromDOM(nestedEditor);
    nested?.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.state.doc.toString()).toBe(`${TABLE}\n| | |\n\nafter`);
    expect(
      view.dom.querySelector('[data-editing="true"]')?.getAttribute("data-row"),
    ).toBe("2");
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("0");

    const activeEditor = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    const active =
      activeEditor === null ? null : EditorView.findFromDOM(activeEditor);
    active?.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(runEditorCommand("table.cell.enter-up")).toBe(true);
    expect(
      view.dom.querySelector('[data-editing="true"]')?.getAttribute("data-row"),
    ).toBe("2");
  });

  it("enters the same column and grows it from the last rendered row", async () => {
    const view = makeView(TABLE, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(focusRenderedTableCell(view, 0, 0, 1, "start")).toBe(true);
    const pressEnter = () => {
      const editor = view.dom.querySelector<HTMLElement>(
        '.cm-skr-table-cell[data-editing="true"] .cm-editor',
      );
      const nested = editor === null ? null : EditorView.findFromDOM(editor);
      nested?.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    pressEnter();
    expect(view.state.doc.toString()).toBe(TABLE);
    expect(
      view.dom.querySelector('[data-editing="true"]')?.getAttribute("data-row"),
    ).toBe("1");
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("1");

    pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.state.doc.toString()).toBe(`${TABLE}\n| | |`);
    expect(
      view.dom.querySelector('[data-editing="true"]')?.getAttribute("data-row"),
    ).toBe("2");
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("1");
  });

  it("inserts rows and columns from the registered commands", () => {
    const view = makeView(TABLE, TABLE.indexOf("c"), [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(runEditorCommand("table.row.insert-below")).toBe(true);
    expect(view.state.doc.toString().split("\n")).toHaveLength(4);
    expect(runEditorCommand("table.column.insert-after")).toBe(true);
    const header = view.state.doc.toString().split("\n")[0] ?? "";
    expect(header.split("|").length).toBe(5);
  });

  it("produces exact documents for all six structure commands", () => {
    const cases = [
      ["table.row.insert-above", "| a | b |\n| --- | --- |\n| | |\n| c | d |"],
      ["table.row.insert-below", "| a | b |\n| --- | --- |\n| c | d |\n| | |"],
      [
        "table.column.insert-before",
        "| | a | b |\n| --- | --- | --- |\n| | c | d |",
      ],
      [
        "table.column.insert-after",
        "| a | | b |\n| --- | --- | --- |\n| c | | d |",
      ],
      ["table.row.delete", "| a | b |\n| --- | --- |"],
      ["table.column.delete", "| b |\n| --- |\n| d |"],
    ] as const;
    for (const [id, expected] of cases) {
      const view = makeView(TABLE, TABLE.indexOf("c"), [
        decorationEngine(),
        tableEditingExtension(registry, context),
      ]);
      expect(runEditorCommand(id)).toBe(true);
      expect(view.state.doc.toString(), id).toBe(expected);
      view.destroy();
    }
  }, 15_000);

  it("does not run structure commands in a read-only editor", async () => {
    const view = makeView(TABLE, TABLE.indexOf("c"), [
      EditorState.readOnly.of(true),
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(focusRenderedTableCell(view, 0, 1, 0, "end")).toBe(false);
    expect(runEditorCommand("table.row.delete")).toBe(false);
    expect(runEditorCommand("table.edit-source")).toBe(false);
    expect(view.state.doc.toString()).toBe(TABLE);
    expect(
      view.dom.querySelector('[aria-label="Append table row"]'),
    ).toBeNull();
    expect(view.dom.querySelector('[data-editing="true"]')).toBeNull();
    expect(view.state.doc.toString()).toBe(TABLE);
  });

  it("keeps a valid table when changing the focused header row", () => {
    const cases = [
      ["table.row.insert-above", "| | |\n| --- | --- |\n| a | b |\n| c | d |"],
      ["table.row.delete", "| c | d |\n| --- | --- |"],
    ] as const;
    for (const [id, expected] of cases) {
      const view = makeView(TABLE, 0, [
        decorationEngine(),
        tableEditingExtension(registry, context),
      ]);
      expect(focusRenderedTableCell(view, 0, 0, 0, "end")).toBe(true);
      expect(runEditorCommand(id)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      expect(view.dom.querySelector('[role="grid"]')).not.toBeNull();
      view.destroy();
    }
  });

  it("shows raw table source through its registered command", async () => {
    const view = makeView(TABLE, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(runEditorCommand("table.cell.next")).toBe(true);
    expect(view.dom.querySelector('[role="grid"]')).not.toBeNull();
    expect(runEditorCommand("table.edit-source")).toBe(true);
    await Promise.resolve();
    expect(view.dom.querySelector('[role="grid"]')).toBeNull();
    expect(view.contentDOM.textContent).toContain("| --- | --- |");
    view.dispatch({ selection: { anchor: TABLE.indexOf("b") } });
    expect(runEditorCommand("table.source.close")).toBe(true);
    await Promise.resolve();
    expect(view.dom.querySelector('[role="grid"]')).not.toBeNull();
    expect(
      view.dom.querySelector('[data-editing="true"]')?.getAttribute("data-row"),
    ).toBe("0");
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("1");
  });

  it("routes the row and column insertion strips through registry commands", async () => {
    const rowView = makeView(TABLE, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    const rowButton = rowView.dom.querySelector<HTMLButtonElement>(
      '[aria-label="Append table row"]',
    );
    expect(
      rowButton?.parentElement?.classList.contains("cm-skr-table-shell"),
    ).toBe(true);
    expect(rowButton?.tabIndex).toBe(-1);
    expect(getComputedStyle(rowButton as HTMLButtonElement).height).toBe(
      "28px",
    );
    rowButton?.click();
    await Promise.resolve();
    expect(rowView.state.doc.toString()).toBe(`${TABLE}\n| | |`);
    rowView.destroy();

    const columnView = makeView(TABLE, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    const columnButton = columnView.dom.querySelector<HTMLButtonElement>(
      '[aria-label="Append table column"]',
    );
    expect(columnButton?.tabIndex).toBe(-1);
    expect(getComputedStyle(columnButton as HTMLButtonElement).width).toBe(
      "28px",
    );
    columnButton?.click();
    await Promise.resolve();
    expect(columnView.state.doc.toString()).toBe(
      "| a | b | |\n| --- | --- | --- |\n| c | d | |",
    );
  });

  it("routes ragged insertion strips from existing edge cells", async () => {
    const ragged = "| a | b | c |\n| --- | --- | --- |\n| x |";
    const rowView = makeView(ragged, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    rowView.dom
      .querySelector<HTMLButtonElement>('[aria-label="Append table row"]')
      ?.click();
    await Promise.resolve();
    expect(rowView.state.doc.toString()).toBe(`${ragged}\n| | | |`);
    rowView.destroy();

    const columnView = makeView(ragged, 0, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    columnView.dom
      .querySelector<HTMLButtonElement>('[aria-label="Append table column"]')
      ?.click();
    await Promise.resolve();
    expect(columnView.state.doc.toString()).toBe(
      "| a | b | c | |\n| --- | --- | --- | --- |\n| x | | | |",
    );
  });

  it("travels through thirty rendered rows without revealing source", () => {
    const body = Array.from(
      { length: 30 },
      (_, index) => `| row ${index + 1} | value ${index + 1} |`,
    );
    const source = [
      "before",
      "| Name | Value |",
      "| --- | --- |",
      ...body,
      "",
      "after",
    ].join("\n");
    const view = makeView(source, source.indexOf("before") + 6, [
      decorationEngine(),
      tableEditingExtension(registry, context),
    ]);
    expect(runEditorCommand("table.cell.enter-down")).toBe(true);
    expect(
      view.dom.querySelector('[data-editing="true"]')?.getAttribute("data-row"),
    ).toBe("0");
    for (let row = 1; row <= 30; row += 1) {
      const activeEditor = view.dom.querySelector<HTMLElement>(
        '.cm-skr-table-cell[data-editing="true"] .cm-editor',
      );
      const active =
        activeEditor === null ? null : EditorView.findFromDOM(activeEditor);
      active?.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(
        view.dom
          .querySelector('[data-editing="true"]')
          ?.getAttribute("data-row"),
      ).toBe(String(row));
    }
    const lastEditor = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    (lastEditor === null
      ? null
      : EditorView.findFromDOM(lastEditor)
    )?.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.dom.querySelector('[data-editing="true"]')).toBeNull();
    expect(view.state.selection.main.head).toBe(source.indexOf("after") - 1);
    expect(view.contentDOM.textContent).not.toContain("| --- | --- |");
  }, 30_000);
});

describe("in-note find through the registry", () => {
  it("claims Mod-f globally, so a browser find bar cannot win before the editor gains focus", () => {
    activeView = makeView("beta beta beta\n", 0);
    expect(searchPanelOpen(activeView.state)).toBe(false);

    // Dispatched on an element the editor never sees, unlike a chord typed
    // into the CodeMirror content: only a window-level, not editor-scope,
    // binding reaches this.
    const outsideElement = document.createElement("div");
    document.body.append(outsideElement);
    const event = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    globalKeydownHandler(registry, context)(event);

    expect(searchPanelOpen(activeView.state)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    outsideElement.remove();
  });

  it("declines to claim Mod-f, leaving the browser default, when no note is open", () => {
    activeView = undefined;
    const event = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      cancelable: true,
    });
    globalKeydownHandler(registry, context)(event);
    expect(event.defaultPrevented).toBe(false);
  });

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
    replaceAllButton?.click();
    expect(view.state.doc.toString()).toBe("gamma gamma gamma\n");

    expect(runEditorCommand("find.close")).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(runEditorCommand("find.close")).toBe(false);
  });
});

describe("selection toolbar placement", () => {
  // A window wide enough that the reading column leaves generous margin.
  const wide = {
    columnLeft: 400,
    columnRight: 880,
    scrollerLeft: 0,
    scrollerRight: 1280,
    toolbarWidth: 172,
    leftToRight: true,
  };

  it("takes the trailing margin when it holds the toolbar clear of the text", () => {
    const placement = toolbarPlacement(wide);
    expect(placement.kind).toBe("margin");
    if (placement.kind !== "margin") throw new Error("expected the margin");
    expect(placement.left).toBeGreaterThanOrEqual(wide.columnRight);
  });

  it("takes the leading margin when only that side holds the toolbar", () => {
    const placement = toolbarPlacement({ ...wide, scrollerRight: 900 });
    expect(placement.kind).toBe("margin");
    if (placement.kind !== "margin") throw new Error("expected the margin");
    expect(placement.left + wide.toolbarWidth).toBeLessThanOrEqual(
      wide.columnLeft,
    );
  });

  it("prefers the leading margin when the text runs right to left", () => {
    const placement = toolbarPlacement({ ...wide, leftToRight: false });
    expect(placement.kind).toBe("margin");
    if (placement.kind !== "margin") throw new Error("expected the margin");
    expect(placement.left + wide.toolbarWidth).toBeLessThanOrEqual(
      wide.columnLeft,
    );
  });

  it("reports nowhere to go when neither margin holds the toolbar", () => {
    // A narrow window: the column nearly fills the scroller on both sides.
    expect(
      toolbarPlacement({
        columnLeft: 24,
        columnRight: 366,
        scrollerLeft: 0,
        scrollerRight: 390,
        toolbarWidth: 172,
        leftToRight: true,
      }).kind,
    ).toBe("over-text");
  });

  it("reports nowhere to go when a margin is only as wide as the toolbar", () => {
    // Clearance from the text is part of fitting, not a decoration on it, so
    // a margin exactly the toolbar's width is not wide enough on either side.
    expect(
      toolbarPlacement({
        ...wide,
        scrollerLeft: wide.columnLeft - wide.toolbarWidth,
        scrollerRight: wide.columnRight + wide.toolbarWidth,
      }).kind,
    ).toBe("over-text");
  });
});
