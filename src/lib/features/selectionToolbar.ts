// The select-to-style toolbar: a floating toolbar over a non-empty
// selection whose buttons run the registry's `format.*` commands. The
// toolbar owns no formatting logic and no keybindings; it is a pointer
// surface over registered commands.

import {
  type Extension,
  Facet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Direction,
  type EditorView,
  showTooltip,
  type Tooltip,
  EditorView as View,
  ViewPlugin,
  type ViewUpdate,
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

/** Clear space kept between the toolbar and the edge of the reading column. */
const MARGIN_GAP = 12;

/** Clear space kept above the text when the toolbar has to sit over it. */
const OVER_TEXT_GAP = 8;

/** An anchor far enough outside the editor that the tooltip layer clips it. */
const OFFSCREEN = -1e6;

/**
 * How long a selection must hold still before the toolbar appears. A drag or a
 * held arrow key changes the selection continuously, and a toolbar that tracks
 * every step flickers across the page instead of offering an action.
 */
const SETTLE_MILLISECONDS = 250;

const setSettled = StateEffect.define<boolean>();

/** Whether the current selection has held still long enough to act on. */
const settledField = StateField.define<boolean>({
  create: () => false,
  update(settled, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSettled)) return effect.value;
    }
    // Any change to the selection or the document restarts the wait.
    if (transaction.selection || transaction.docChanged) return false;
    return settled;
  },
});

/** Marks a selection settled once it has stopped changing. */
const settlePlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | undefined;

    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return;
      clearTimeout(this.timer);
      if (update.state.selection.main.empty || update.state.readOnly) return;
      this.timer = setTimeout(() => {
        update.view.dispatch({ effects: setSettled.of(true) });
      }, SETTLE_MILLISECONDS);
    }

    destroy() {
      clearTimeout(this.timer);
    }
  },
);

/** The reading column's edges: the line box inset by the line's own padding. */
function readingColumn(view: EditorView): { left: number; right: number } {
  const content = view.contentDOM.getBoundingClientRect();
  const line = view.contentDOM.querySelector(".cm-line");
  if (line === null) return { left: content.left, right: content.right };
  const style = window.getComputedStyle(line);
  return {
    left: content.left + Number.parseFloat(style.paddingLeft || "0"),
    right: content.right - Number.parseFloat(style.paddingRight || "0"),
  };
}

/**
 * Anchors the toolbar in the margin beside the selection rather than over the
 * prose above it.
 *
 * The editor holds a fixed reading measure, so on any window wide enough there
 * is empty margin either side of the text. Placing the toolbar there keeps
 * every line legible while it is open, which a surface floating over the line
 * above cannot do. The returned rectangle is read against `above: true`, so
 * offsetting its top by the toolbar's own height leaves the toolbar level with
 * the line the selection starts on.
 *
 * A window too narrow to hold the toolbar clear of the text has no margin to
 * use, and falls back to the position over the text.
 */
/** Where the toolbar can sit for one measured layout. */
export type ToolbarPlacement =
  | { kind: "margin"; left: number }
  | { kind: "over-text" };

/** The measurements the placement decision reads, in viewport pixels. */
export type PlacementGeometry = {
  columnLeft: number;
  columnRight: number;
  scrollerLeft: number;
  scrollerRight: number;
  toolbarWidth: number;
  leftToRight: boolean;
};

/**
 * Chooses the margin beside the reading column when one is wide enough to
 * hold the toolbar clear of the text, and reports that there is nowhere to go
 * when neither is. The trailing margin is preferred, so the toolbar sits on
 * the side a selection ends.
 */
export function toolbarPlacement(
  geometry: PlacementGeometry,
): ToolbarPlacement {
  const trailing = {
    room: geometry.scrollerRight - geometry.columnRight,
    left: geometry.columnRight + MARGIN_GAP,
  };
  const leading = {
    room: geometry.columnLeft - geometry.scrollerLeft,
    left: geometry.columnLeft - MARGIN_GAP - geometry.toolbarWidth,
  };
  const ordered = geometry.leftToRight
    ? [trailing, leading]
    : [leading, trailing];
  const side = ordered.find(
    (candidate) => candidate.room >= geometry.toolbarWidth + MARGIN_GAP,
  );
  return side === undefined
    ? { kind: "over-text" }
    : { kind: "margin", left: side.left };
}

function marginAnchor(
  view: EditorView,
  pos: number,
  dom: HTMLElement,
): { left: number; right: number; top: number; bottom: number } {
  const coords = view.coordsAtPos(pos);
  // An unrendered position has nothing to anchor to. An anchor this far
  // outside the editor is clipped away, which is what should happen to a
  // toolbar for a selection that is not on screen.
  if (coords === null) {
    return {
      left: OFFSCREEN,
      right: OFFSCREEN,
      top: OFFSCREEN,
      bottom: OFFSCREEN,
    };
  }
  // The margin lays the toolbar out as a single narrow column (see the
  // theme below), so that is the width the fit decision has to measure:
  // the row layout it would fall back to is wide enough to rarely fit
  // beside the reading column at all, which was the point of stacking it.
  dom.dataset.placement = "margin";
  const width = dom.offsetWidth;
  const height = dom.offsetHeight;
  if (width === 0 || height === 0) return coords;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const column = readingColumn(view);
  const placement = toolbarPlacement({
    columnLeft: column.left,
    columnRight: column.right,
    scrollerLeft: scroller.left,
    scrollerRight: scroller.right,
    toolbarWidth: width,
    leftToRight: view.textDirection === Direction.LTR,
  });
  if (placement.kind === "over-text") {
    dom.dataset.placement = "over-text";
    return coords;
  }
  // `above` subtracts the toolbar's height from this top edge, leaving the
  // toolbar level with the line rather than floating above it.
  return {
    left: placement.left,
    right: placement.left,
    top: coords.top + height,
    bottom: coords.top + height,
  };
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
        getCoords: (pos: number) => marginAnchor(tooltipView, pos, dom),
        // Only the placement that has to sit over the text buys clearance
        // from it; the margin placement is already clear.
        get offset() {
          return {
            x: 0,
            y: dom.dataset.placement === "margin" ? 0 : OVER_TEXT_GAP,
          };
        },
        destroy: () => {
          for (const cleanup of cleanups) cleanup();
        },
      };
    },
  };
}

const toolbarField = showTooltip.compute(
  ["selection", "doc", settledField],
  (state) => {
    // The tooltip is recomputed from the live view in `create`; the facet
    // value only gates existence on a settled, non-empty selection.
    if (state.selection.main.empty || state.readOnly) {
      return null;
    }
    if (!state.field(settledField)) {
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
  },
);

const toolbarTheme = View.theme({
  ".cm-tooltip.cm-skr-selection-toolbar, .cm-skr-selection-toolbar": {
    display: "flex",
    gap: "3px",
    padding: "4px",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    border: "1px solid var(--skr-border)",
    borderRadius: "var(--skr-radius-surface)",
    boxShadow: "var(--skr-shadow)",
    fontFamily: "var(--skr-font-interface)",
  },
  ".cm-skr-toolbar-button": {
    border: "none",
    background: "transparent",
    color: "var(--skr-text)",
    borderRadius: "var(--skr-radius-control)",
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
  // A window with no margin to spare puts the toolbar over the prose. It
  // carries less height there, so it covers one line rather than crowding the
  // two around it.
  '.cm-skr-selection-toolbar[data-placement="over-text"] .cm-skr-toolbar-button':
    {
      minWidth: "26px",
      minHeight: "26px",
      padding: "2px 6px",
    },
  // The margin rarely has room for the toolbar's full row width beside the
  // reading column; stacked into one narrow column it very nearly always
  // does, so a selection almost never has to fall back to sitting over text.
  '.cm-skr-selection-toolbar[data-placement="margin"]': {
    flexDirection: "column",
  },
});

/** The selection toolbar extension over the registry's format commands. */
export function selectionToolbar(
  registry: CommandRegistry,
  contextProvider: () => CommandContext,
): Extension {
  return [
    toolbarConfig.of({ registry, contextProvider }),
    settledField,
    settlePlugin,
    toolbarField,
    toolbarTheme,
  ];
}
