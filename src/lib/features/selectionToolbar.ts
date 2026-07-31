// The select-to-style toolbar: a floating toolbar over a non-empty
// selection whose buttons run the registry's `format.*` commands. The
// toolbar owns no formatting logic and no keybindings; it is a pointer
// surface over registered commands.

import { type Extension, Facet } from "@codemirror/state";
import {
  type EditorView,
  showTooltip,
  type Tooltip,
  EditorView as View,
} from "@codemirror/view";
import type { CommandContext, CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

type ToolbarConfig = {
  registry: CommandRegistry;
  contextProvider: () => CommandContext;
};

const toolbarConfig = Facet.define<ToolbarConfig, ToolbarConfig | null>({
  combine: (values) => values[0] ?? null,
});

/** The toolbar's buttons: command id and accessible label. */
const TOOLBAR_BUTTONS: readonly { id: string; label: string; glyph: string }[] =
  [
    { id: "format.bold", label: STRINGS.formatBold, glyph: "B" },
    { id: "format.italic", label: STRINGS.formatItalic, glyph: "I" },
    { id: "format.code", label: STRINGS.formatCode, glyph: "`" },
    {
      id: "format.strikethrough",
      label: STRINGS.formatStrikethrough,
      glyph: "S",
    },
    { id: "format.wikilink", label: STRINGS.formatWikilink, glyph: "[[" },
  ];

function toolbarTooltip(view: EditorView): Tooltip | null {
  const range = view.state.selection.main;
  if (range.empty || view.state.readOnly) {
    return null;
  }
  return {
    pos: Math.min(range.from, range.to),
    above: true,
    create: (tooltipView) => {
      const dom = document.createElement("div");
      dom.className = "cm-skr-selection-toolbar";
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", STRINGS.selectionToolbarLabel);
      const config = tooltipView.state.facet(toolbarConfig);
      for (const button of TOOLBAR_BUTTONS) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "cm-skr-toolbar-button";
        element.setAttribute("aria-label", button.label);
        element.title = button.label;
        element.textContent = button.glyph;
        // Mousedown instead of click so the editor selection survives.
        element.addEventListener("mousedown", (event) => {
          event.preventDefault();
          if (config !== null) {
            config.registry.run(button.id, {
              ...config.contextProvider(),
              view: tooltipView,
            });
          }
        });
        dom.append(element);
      }
      return { dom };
    },
  };
}

const toolbarField = showTooltip.compute(["selection", "doc"], (state) => {
  // The tooltip is recomputed from the live view in `create`; the facet
  // value only gates existence on a non-empty selection.
  if (state.selection.main.empty || state.readOnly) {
    return null;
  }
  return {
    pos: Math.min(state.selection.main.from, state.selection.main.to),
    above: true,
    create: (view) => {
      const tooltip = toolbarTooltip(view);
      if (tooltip === null) {
        return { dom: document.createElement("div") };
      }
      return tooltip.create(view);
    },
  };
});

const toolbarTheme = View.baseTheme({
  ".cm-skr-selection-toolbar": {
    display: "flex",
    gap: "2px",
    padding: "2px",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    border: "1px solid var(--skr-border)",
    borderRadius: "6px",
    boxShadow: "var(--skr-shadow)",
  },
  ".cm-skr-toolbar-button": {
    border: "none",
    background: "transparent",
    borderRadius: "4px",
    padding: "1px 6px",
    cursor: "pointer",
    fontWeight: "600",
  },
  ".cm-skr-toolbar-button:hover": {
    backgroundColor: "var(--skr-surface-subtle)",
  },
});

/** The selection toolbar extension over the registry's format commands. */
export function selectionToolbar(
  registry: CommandRegistry,
  contextProvider: () => CommandContext,
): Extension {
  return [
    toolbarConfig.of({ registry, contextProvider }),
    toolbarField,
    toolbarTheme,
  ];
}
