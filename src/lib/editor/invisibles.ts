import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

const invisibleMatcher = new MatchDecorator({
  regexp: /[\t ]/gu,
  decoration: (match) =>
    Decoration.mark({
      class:
        match[0] === "\t" ? "cm-skr-invisible-tab" : "cm-skr-invisible-space",
    }),
});

const invisiblePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = invisibleMatcher.createDeco(view);
    }

    update(update: ViewUpdate): void {
      this.decorations = invisibleMatcher.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

class LineEndWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-skr-invisible-line-end";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = "↵";
    return marker;
  }
}

const lineEndWidget = new LineEndWidget();

function lineEndDecorations(view: EditorView): DecorationSet {
  const ranges = view.visibleRanges.flatMap(({ from, to }) => {
    const result = [];
    let line = view.state.doc.lineAt(from);
    while (line.from <= to) {
      if (line.to < view.state.doc.length) {
        result.push(
          Decoration.widget({ widget: lineEndWidget, side: 1 }).range(line.to),
        );
      }
      if (line.to === view.state.doc.length) break;
      line = view.state.doc.line(line.number + 1);
    }
    return result;
  });
  return Decoration.set(ranges, true);
}

const lineEndPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = lineEndDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = lineEndDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

const invisibleTheme = EditorView.baseTheme({
  ".cm-skr-invisible-space, .cm-skr-invisible-tab": {
    position: "relative",
  },
  ".cm-skr-invisible-space::before, .cm-skr-invisible-tab::before": {
    position: "absolute",
    color: "var(--skr-text-muted)",
    pointerEvents: "none",
  },
  ".cm-skr-invisible-line-end": {
    color: "var(--skr-text-muted)",
    pointerEvents: "none",
  },
  ".cm-skr-invisible-space::before": {
    content: '"·"',
  },
  ".cm-skr-invisible-tab::before": {
    content: '"→"',
  },
});

/** Shows spaces, tabs, and line endings without changing document offsets. */
export function showInvisibleCharacters(): Extension {
  return [invisiblePlugin, lineEndPlugin, invisibleTheme];
}
