// Criterion 6 (M2): the decoration engine is data-driven. A rule added to
// the table at runtime produces its decoration with no engine change; the
// companion CI check (scripts/check-table-only-diff.sh) verifies that a
// diff changing the table touches only the table file, tests and the
// rules document.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
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

const HORIZONTAL_RULE_ROW: DecorationRule = {
  node: "HorizontalRule",
  presentation: { present: "mark", class: "cm-test-horizontal-rule" },
  reveal: "never",
};

function mountedView(extra: Parameters<Compartment["of"]>[0]): EditorView {
  return new EditorView({
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
});
