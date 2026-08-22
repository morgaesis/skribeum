// Criterion 6 (M2): the decoration engine is data-driven. A rule added to
// the table at runtime produces its decoration with no engine change; the
// companion CI check (scripts/check-table-only-diff.sh) verifies that a
// diff changing the table touches only the table file, tests and the
// rules document.

import { deleteCharBackward, history, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  BULK_TEXT_INPUT_LENGTH,
  bulkTextInput,
} from "../../src/lib/editor/bulkInput";
import { decorationOrigin } from "../../src/lib/editor/decorationGuard";
import {
  decorationEngine,
  decorationTable,
  engineDecorations,
  serializeDecorationSet,
} from "../../src/lib/editor/decorations/engine";
import {
  DECORATION_TABLE,
  type DecorationRule,
} from "../../src/lib/editor/decorations/table";
import { obsidianMarkdownExtensions } from "../../src/lib/editor/markdown/obsidian";

const PARAGRAPH_ROW: DecorationRule = {
  node: "Paragraph",
  presentation: { present: "mark", class: "cm-test-paragraph" },
  reveal: "never",
};

/**
 * A rule the engine cannot satisfy: an image widget over a node that is not
 * an image, so building the widget throws where a rule computing an
 * impossible range would.
 */
const FAILING_ROW: DecorationRule = {
  node: "Paragraph",
  presentation: { present: "widget", widget: "image" },
  reveal: "never",
};

function mountedView(extra: Parameters<Compartment["of"]>[0]): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: "before\n\n---\n\nafter with *emphasis*\n",
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensions,
        }),
        decorationEngine(),
        extra,
      ],
    }),
  });
  if (!forceParsing(view, view.state.doc.length, 1_000)) {
    view.destroy();
    throw new Error("fixture syntax tree did not finish parsing");
  }
  return view;
}

function waitForFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const next = (remaining: number) => {
      requestAnimationFrame(() => {
        if (remaining === 1) {
          resolve();
        } else {
          next(remaining - 1);
        }
      });
    };
    next(count);
  });
}

describe("data-driven decoration table", () => {
  it("a rule added at runtime produces its decoration", () => {
    const compartment = new Compartment();
    const view = mountedView(compartment.of([]));
    try {
      const before = serializeDecorationSet(
        engineDecorations(view) ?? Decoration.none,
      );
      expect(before).not.toContain("cm-test-paragraph");
      // The committed table decorates the emphasis on the last line.
      expect(before).toContain("cm-skr-emphasis");

      view.dispatch({
        effects: compartment.reconfigure(
          decorationTable.of([...DECORATION_TABLE, PARAGRAPH_ROW]),
        ),
        annotations: decorationOrigin.of(true),
      });

      const after = serializeDecorationSet(
        engineDecorations(view) ?? Decoration.none,
      );
      expect(after).toContain('mark class="cm-test-paragraph"');
      // The committed rows keep applying alongside the added one.
      expect(after).toContain("cm-skr-emphasis");
      expect(view.state.doc.toString()).toContain("before");
    } finally {
      view.destroy();
    }
  });

  it("the added rule also renders into the DOM", () => {
    const compartment = new Compartment();
    const view = mountedView(
      compartment.of(decorationTable.of([...DECORATION_TABLE, PARAGRAPH_ROW])),
    );
    try {
      document.body.append(view.dom);
      expect(
        view.contentDOM.querySelector(".cm-test-paragraph"),
      ).not.toBeNull();
    } finally {
      view.destroy();
      view.dom.remove();
    }
  });

  // A rule that fails is a defect in that rule, and it must cost the note
  // that rule's decoration and nothing else. CodeMirror disables a
  // decoration provider that throws for the life of the view, so without
  // containment the note renders as raw source and repairing the text does
  // not bring it back.
  it("keeps the note rendered when a rule misbehaves", () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const compartment = new Compartment();
    const view = mountedView(compartment.of([]));
    document.body.append(view.dom);
    try {
      expect(view.contentDOM.querySelector(".cm-skr-emphasis")).not.toBeNull();

      view.dispatch({
        effects: compartment.reconfigure(
          decorationTable.of([...DECORATION_TABLE, FAILING_ROW]),
        ),
        annotations: decorationOrigin.of(true),
      });

      // The note keeps the rendering it had, and the failure is reported.
      expect(view.contentDOM.querySelector(".cm-skr-emphasis")).not.toBeNull();
      expect(reported).toHaveBeenCalled();

      // The provider is still alive: a later table takes effect.
      view.dispatch({
        effects: compartment.reconfigure(
          decorationTable.of([...DECORATION_TABLE, PARAGRAPH_ROW]),
        ),
        annotations: decorationOrigin.of(true),
      });
      expect(
        view.contentDOM.querySelector(".cm-test-paragraph"),
      ).not.toBeNull();
      expect(view.contentDOM.querySelector(".cm-skr-emphasis")).not.toBeNull();
      // Typing after the failure keeps rendering, which is what a reader
      // repairing the construct that caused it does.
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "\n# after\n" },
      });
      expect(forceParsing(view, view.state.doc.length, 1_000)).toBe(true);
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(view.contentDOM.querySelector(".cm-skr-heading")).not.toBeNull();
    } finally {
      view.destroy();
      view.dom.remove();
      reported.mockRestore();
    }
  });

  it("restores complete decorations a few frames after bulk input", async () => {
    const compartment = new Compartment();
    const view = mountedView(compartment.of(bulkTextInput()));
    document.body.append(view.dom);
    try {
      const text = `${"[[bulk target]]\n".repeat(BULK_TEXT_INPUT_LENGTH / 8)}`;
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: "insertText",
      });

      expect(view.contentDOM.dispatchEvent(event)).toBe(false);
      expect(
        serializeDecorationSet(engineDecorations(view) ?? Decoration.none),
      ).not.toContain("cm-skr-wikilink");
      expect(forceParsing(view, view.state.doc.length, 1_000)).toBe(true);

      await new Promise<void>((resolve) => {
        const waitForFrame = (remaining: number) => {
          requestAnimationFrame(() => {
            if (remaining === 1) {
              resolve();
            } else {
              waitForFrame(remaining - 1);
            }
          });
        };
        waitForFrame(4);
      });

      expect(
        serializeDecorationSet(engineDecorations(view) ?? Decoration.none),
      ).toContain("cm-skr-wikilink");
    } finally {
      view.destroy();
      view.dom.remove();
    }
  });

  it("updates source reveal immediately through deferred deletion and history", async () => {
    const doc = "# reveal\n\noutside";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.lastIndexOf("#") + 1 },
        extensions: [
          markdown({
            base: markdownLanguage,
            extensions: obsidianMarkdownExtensions,
          }),
          history(),
          decorationEngine(),
        ],
      }),
      parent: document.body,
    });
    try {
      expect(forceParsing(view, view.state.doc.length, 1_000)).toBe(true);
      expect(deleteCharBackward(view)).toBe(true);
      expect(view.dom.querySelector(".cm-skr-reveal-marker")).toBeNull();

      expect(undo(view)).toBe(true);
      expect(
        view.dom
          .querySelector(".cm-skr-reveal-marker")
          ?.classList.contains("cm-skr-reveal-marker-active"),
      ).toBe(true);

      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(
        view.dom
          .querySelector(".cm-skr-reveal-marker")
          ?.classList.contains("cm-skr-reveal-marker-active"),
      ).toBe(false);

      view.dispatch({ selection: { anchor: 1 } });
      expect(redo(view)).toBe(true);
      expect(view.dom.querySelector(".cm-skr-reveal-marker")).toBeNull();
    } finally {
      view.destroy();
      view.dom.remove();
    }
  }, 15_000);

  it("keeps a deferred block refresh scheduled across a viewport update", async () => {
    let viewportUpdates = 0;
    const viewportProbe = ViewPlugin.fromClass(
      class {
        update(update: { viewportChanged: boolean }): void {
          if (update.viewportChanged) viewportUpdates += 1;
        }
      },
    );
    const view = mountedView(
      new Compartment().of([bulkTextInput(), viewportProbe]),
    );
    document.body.append(view.dom);
    try {
      Object.defineProperty(view.scrollDOM, "clientHeight", {
        configurable: true,
        value: 120,
      });
      const text = `${"plain line\n".repeat(BULK_TEXT_INPUT_LENGTH / 4)}\n| A |\n| --- |\n| B |`;
      expect(
        view.contentDOM.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: "insertText",
          }),
        ),
      ).toBe(false);
      expect(forceParsing(view, view.state.doc.length, 1_000)).toBe(true);
      // The bulk insert leaves the caret at the pasted table's end, which
      // keeps the table as source under cursor-inside-after-start; the
      // deferred refresh under test needs the caret elsewhere so the grid
      // may mount at all.
      view.dispatch({ selection: { anchor: 0 } });

      view.scrollDOM.scrollTop = 160;
      view.scrollDOM.dispatchEvent(new Event("scroll"));
      await waitForFrames(1);
      expect(viewportUpdates).toBeGreaterThan(0);

      await waitForFrames(4);
      expect(view.dom.querySelector('[role="grid"]')).not.toBeNull();
    } finally {
      view.destroy();
      view.dom.remove();
    }
  });

  it("renders explicit structural changes synchronously", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "plain",
        extensions: [
          markdown({
            base: markdownLanguage,
            extensions: obsidianMarkdownExtensions,
          }),
          decorationEngine(),
        ],
      }),
      parent: document.body,
    });
    try {
      view.dispatch({
        changes: [
          { from: 0, insert: "**" },
          { from: view.state.doc.length, insert: "**" },
        ],
        userEvent: "input.format",
      });
      expect(view.dom.querySelector(".cm-skr-strong")).not.toBeNull();
    } finally {
      view.destroy();
      view.dom.remove();
    }
  });
});
