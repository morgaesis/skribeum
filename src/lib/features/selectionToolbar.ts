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
import { commandTooltip } from "../commandTooltip";
import { enterMotionSurface } from "../motion";
import type { CommandContext, CommandRegistry } from "../registry";
import { formatKeybinding } from "../registry";
import { STRINGS } from "../strings";

type ToolbarConfig = {
  registry: CommandRegistry;
  contextProvider: () => CommandContext;
};

const toolbarConfig = Facet.define<ToolbarConfig, ToolbarConfig | null>({
  combine: (values) => values[0] ?? null,
});

/** The toolbar owns glyphs only. Titles and bindings come from the registry. */
const TOOLBAR_BUTTONS: readonly { id: string; glyph: string }[] = [
  { id: "format.bold", glyph: "B" },
  { id: "format.italic", glyph: "I" },
  { id: "format.code", glyph: "`" },
  { id: "format.strikethrough", glyph: "S" },
  { id: "format.wikilink", glyph: "[[" },
];

function isMacPlatform(): boolean {
  return /Mac|iP[ao]d|iPhone/.test(navigator.platform);
}

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
      dom.dataset.motionSurface = "anchored-bottom";
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", STRINGS.selectionToolbarLabel);
      const config = tooltipView.state.facet(toolbarConfig);
      const cleanups: (() => void)[] = [];
      for (const button of TOOLBAR_BUTTONS) {
        const command = config?.registry.command(button.id);
        const binding = command?.keybindings?.[0];
        if (command === undefined || binding === undefined) continue;
        const element = document.createElement("button");
        element.type = "button";
        element.className = "cm-skr-toolbar-button";
        element.dataset.commandId = button.id;
        element.setAttribute("aria-label", command.title);
        element.textContent = button.glyph;
        cleanups.push(
          commandTooltip(element, {
            title: command.title,
            keybinding: formatKeybinding(binding, isMacPlatform()),
          }).destroy,
        );
        // Prevent pointer focus from replacing the editor selection. Click
        // still handles both pointer activation and keyboard activation.
        element.addEventListener("pointerdown", (event) => {
          event.preventDefault();
        });
        element.addEventListener("click", () => {
          if (config !== null) {
            config.registry.run(button.id, {
              ...config.contextProvider(),
              view: tooltipView,
            });
          }
        });
        dom.append(element);
      }
      enterMotionSurface(dom);
      return {
        dom,
        destroy: () => {
          for (const cleanup of cleanups) cleanup();
        },
      };
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

const toolbarTheme = View.theme({
  ".cm-tooltip.cm-skr-selection-toolbar, .cm-skr-selection-toolbar": {
    display: "flex",
    gap: "3px",
    padding: "4px",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    border: "1px solid var(--skr-border)",
    borderRadius: "9px",
    boxShadow: "var(--skr-shadow)",
    fontFamily: "var(--skr-font-interface)",
  },
  ".cm-skr-toolbar-button": {
    border: "none",
    background: "transparent",
    color: "var(--skr-text)",
    borderRadius: "6px",
    minWidth: "30px",
    minHeight: "30px",
    padding: "3px 7px",
    cursor: "pointer",
    fontWeight: "600",
    lineHeight: "1",
  },
  ".cm-skr-toolbar-button:hover": {
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-subtle)",
  },
  ".cm-skr-toolbar-button:focus-visible": {
    outline: "2px solid var(--skr-focus)",
    outlineOffset: "-2px",
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
