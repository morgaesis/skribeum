// Criterion 6 (M2): the decoration engine is data-driven. A rule added to
// the table at runtime produces its decoration with no engine change; the
// companion CI check (scripts/check-table-only-diff.sh) verifies that a
// diff changing the table touches only the table file, tests and the
// rules document.

import {
  deleteCharBackward,
  deleteGroupBackward,
  history,
  redo,
  undo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  BULK_TEXT_INPUT_LENGTH,
  bulkTextInput,
} from "../../src/lib/editor/bulkInput";
import { decorationOrigin } from "../../src/lib/editor/decorationGuard";
import {
  decorationBuildCounts,
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

const HORIZONTAL_RULE_ROW: DecorationRule = {
  node: "HorizontalRule",
  presentation: { present: "mark", class: "cm-test-horizontal-rule" },
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
      expect(before).not.toContain("cm-test-horizontal-rule");
      // The committed table decorates the emphasis on the last line.
      expect(before).toContain("cm-skr-emphasis");

      view.dispatch({
        effects: compartment.reconfigure(
          decorationTable.of([...DECORATION_TABLE, HORIZONTAL_RULE_ROW]),
        ),
        annotations: decorationOrigin.of(true),
      });

      const after = serializeDecorationSet(
        engineDecorations(view) ?? Decoration.none,
      );
      expect(after).toContain('mark class="cm-test-horizontal-rule"');
      // The committed rows keep applying alongside the added one.
      expect(after).toContain("cm-skr-emphasis");
      expect(view.state.doc.toString()).toContain("---");
    } finally {
      view.destroy();
    }
  });

  it("the added rule also renders into the DOM", () => {
    const compartment = new Compartment();
    const view = mountedView(
      compartment.of(
        decorationTable.of([...DECORATION_TABLE, HORIZONTAL_RULE_ROW]),
      ),
    );
    try {
      document.body.append(view.dom);
      expect(
        view.contentDOM.querySelector(".cm-test-horizontal-rule"),
      ).not.toBeNull();
    } finally {
      view.destroy();
      view.dom.remove();
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

  it("maps native deletion and history decorations before one coalesced rebuild", async () => {
    const tables = Array.from(
      { length: 180 },
      (_, index) => `| ${index} |\n| --- |\n| value ${index} |`,
    ).join("\n\n");
    const doc = `${tables}\n\n**stable** tail`;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
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
      const before = decorationBuildCounts(view);
      const mapped = serializeDecorationSet(
        engineDecorations(view) ?? Decoration.none,
      );

      expect(deleteCharBackward(view)).toBe(true);
      expect(deleteGroupBackward(view)).toBe(true);
      expect(undo(view)).toBe(true);
      expect(redo(view)).toBe(true);

      expect(decorationBuildCounts(view)).toEqual(before);
      expect(
        serializeDecorationSet(engineDecorations(view) ?? Decoration.none),
      ).toBe(mapped);

      await waitForFrames(4);
      expect(decorationBuildCounts(view)).toEqual({
        inline: before.inline + 1,
        block: before.block + 1,
      });
    } finally {
      view.destroy();
      view.dom.remove();
    }
  }, 15_000);

  it("rebuilds explicit structural changes synchronously", () => {
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
      expect(forceParsing(view, view.state.doc.length, 1_000)).toBe(true);
      const before = decorationBuildCounts(view);
      view.dispatch({
        changes: [
          { from: 0, insert: "**" },
          { from: view.state.doc.length, insert: "**" },
        ],
        userEvent: "input.format",
      });

      expect(decorationBuildCounts(view)).toEqual({
        inline: before.inline + 1,
        block: before.block + 1,
      });
      expect(
        serializeDecorationSet(engineDecorations(view) ?? Decoration.none),
      ).toContain("cm-skr-strong");
    } finally {
      view.destroy();
      view.dom.remove();
    }
  });
});
