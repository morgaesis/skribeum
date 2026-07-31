// The slash command menu: typing `/` at a line start or after whitespace
// opens an inline menu of the registry's slash commands, filtered as the
// user types. Accepting an entry removes the `/query` text as a declared
// range and runs the command; menu navigation itself is registry
// keybindings (`slash.*` editor commands), so every key on this surface
// is registered wiring.

import {
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  type EditorView,
  showTooltip,
  type Tooltip,
  EditorView as View,
} from "@codemirror/view";
import { fuzzyMatch } from "../fuzzy";
import type { Command, CommandContext, CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

type SlashState = {
  /** Position of the `/` character. */
  from: number;
  /** Index into the filtered item list. */
  selected: number;
};

type SlashConfig = {
  registry: CommandRegistry;
  contextProvider: () => CommandContext;
};

const slashConfig = Facet.define<SlashConfig, SlashConfig | null>({
  combine: (values) => values[0] ?? null,
});

const setSelected = StateEffect.define<number>();
const closeMenu = StateEffect.define<null>();

function triggerAt(state: EditorState, pos: number): boolean {
  if (pos === 0) {
    return true;
  }
  const before = state.doc.sliceString(pos - 1, pos);
  return before === " " || before === "\t" || before === "\n";
}

function queryOf(state: EditorState, open: SlashState): string | null {
  const head = state.selection.main.head;
  if (!state.selection.main.empty || head < open.from + 1) {
    return null;
  }
  if (state.doc.sliceString(open.from, open.from + 1) !== "/") {
    return null;
  }
  const query = state.doc.sliceString(open.from + 1, head);
  if (/\s/.test(query) || query.length > 64) {
    return null;
  }
  return query;
}

export const slashMenuState = StateField.define<SlashState | null>({
  create: () => null,
  update(value, transaction) {
    let next = value;
    if (next !== null) {
      next = {
        from: transaction.changes.mapPos(next.from, 1),
        selected: transaction.docChanged ? 0 : next.selected,
      };
      if (queryOf(transaction.state, next) === null) {
        next = null;
      }
    }
    if (
      next === null &&
      transaction.docChanged &&
      transaction.isUserEvent("input.type")
    ) {
      transaction.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
        if (
          inserted.toString() === "/" &&
          triggerAt(transaction.state, fromB)
        ) {
          next = { from: fromB, selected: 0 };
        }
      });
      if (next !== null && queryOf(transaction.state, next) === null) {
        next = null;
      }
    }
    for (const effect of transaction.effects) {
      if (effect.is(closeMenu)) {
        next = null;
      } else if (effect.is(setSelected) && next !== null) {
        next = { ...next, selected: effect.value };
      }
    }
    return next;
  },
  provide: (field) =>
    showTooltip.compute([field, "selection", "doc"], (state) => {
      const open = state.field(field);
      return open === null ? null : slashTooltip(open);
    }),
});

/** The registry slash commands matching `query`, ranked. */
export function filteredSlashCommands(
  registry: CommandRegistry,
  query: string,
): Command[] {
  return registry
    .slashCommands()
    .map((command) => {
      const haystack = [command.title, ...(command.slash?.keywords ?? [])].join(
        " ",
      );
      return { command, match: fuzzyMatch(query, haystack) };
    })
    .filter((entry) => entry.match !== null)
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .map((entry) => entry.command);
}

/** Whether the slash menu is open in this state. */
export function slashMenuOpen(state: EditorState): boolean {
  return state.field(slashMenuState, false) != null;
}

function acceptItem(view: EditorView): boolean {
  const open = view.state.field(slashMenuState, false);
  const config = view.state.facet(slashConfig);
  if (open == null || config === null) {
    return false;
  }
  const query = queryOf(view.state, open) ?? "";
  const items = filteredSlashCommands(config.registry, query);
  const item = items[Math.min(open.selected, items.length - 1)];
  view.dispatch({
    changes: {
      from: open.from,
      to: view.state.selection.main.head,
      insert: "",
    },
    effects: closeMenu.of(null),
    userEvent: "input.slash",
  });
  if (item === undefined) {
    return true;
  }
  config.registry.run(item.id, { ...config.contextProvider(), view });
  return true;
}

function moveSelection(view: EditorView, delta: number): boolean {
  const open = view.state.field(slashMenuState, false);
  const config = view.state.facet(slashConfig);
  if (open == null || config === null) {
    return false;
  }
  const query = queryOf(view.state, open) ?? "";
  const count = filteredSlashCommands(config.registry, query).length;
  if (count === 0) {
    return true;
  }
  const selected = (open.selected + delta + count) % count;
  view.dispatch({ effects: setSelected.of(selected) });
  return true;
}

/** Registers the slash menu's navigation commands. */
export function registerSlashMenu(registry: CommandRegistry): void {
  registry.register({
    id: "slash.next",
    title: STRINGS.slashMenuLabel,
    keybindings: ["ArrowDown"],
    scope: "editor",
    palette: false,
    run: (context) =>
      context.view === null ? false : moveSelection(context.view, 1),
  });
  registry.register({
    id: "slash.previous",
    title: STRINGS.slashMenuLabel,
    keybindings: ["ArrowUp"],
    scope: "editor",
    palette: false,
    run: (context) =>
      context.view === null ? false : moveSelection(context.view, -1),
  });
  registry.register({
    id: "slash.accept",
    title: STRINGS.slashMenuLabel,
    keybindings: ["Enter"],
    scope: "editor",
    palette: false,
    run: (context) =>
      context.view === null || !slashMenuOpen(context.view.state)
        ? false
        : acceptItem(context.view),
  });
  registry.register({
    id: "slash.close",
    title: STRINGS.slashMenuLabel,
    keybindings: ["Escape"],
    scope: "editor",
    palette: false,
    run: (context) => {
      const view = context.view;
      if (view === null || !slashMenuOpen(view.state)) {
        return false;
      }
      view.dispatch({ effects: closeMenu.of(null) });
      return true;
    },
  });
}

function slashTooltip(open: SlashState): Tooltip {
  return {
    pos: open.from,
    above: false,
    create: (view) => {
      const dom = document.createElement("ul");
      dom.className = "cm-skr-slash-menu";
      dom.setAttribute("role", "listbox");
      dom.setAttribute("aria-label", STRINGS.slashMenuLabel);
      const render = (renderState: EditorState) => {
        const current = renderState.field(slashMenuState, false);
        const config = renderState.facet(slashConfig);
        dom.replaceChildren();
        if (current == null || config === null) {
          return;
        }
        const query = queryOf(renderState, current) ?? "";
        const items = filteredSlashCommands(config.registry, query);
        if (items.length === 0) {
          const empty = document.createElement("li");
          empty.className = "cm-skr-slash-empty";
          empty.textContent = STRINGS.noMatches;
          dom.append(empty);
          return;
        }
        const selected = Math.min(current.selected, items.length - 1);
        for (const [index, item] of items.entries()) {
          const option = document.createElement("li");
          option.setAttribute("role", "option");
          option.id = `skr-slash-option-${index}`;
          option.setAttribute(
            "aria-selected",
            index === selected ? "true" : "false",
          );
          option.className =
            index === selected
              ? "cm-skr-slash-option cm-skr-slash-option-active"
              : "cm-skr-slash-option";
          option.textContent = item.title;
          option.addEventListener("mousedown", (event) => {
            event.preventDefault();
            view.dispatch({ effects: setSelected.of(index) });
            acceptItem(view);
          });
          dom.append(option);
        }
      };
      render(view.state);
      return {
        dom,
        update: (update) => {
          render(update.state);
        },
      };
    },
  };
}

const slashTheme = View.baseTheme({
  ".cm-skr-slash-menu": {
    listStyle: "none",
    margin: "0",
    padding: "2px",
    minWidth: "12em",
    maxHeight: "14em",
    overflowY: "auto",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    border: "1px solid var(--skr-border)",
    borderRadius: "6px",
    boxShadow: "var(--skr-shadow)",
  },
  ".cm-skr-slash-option": {
    padding: "2px 8px",
    borderRadius: "4px",
    cursor: "pointer",
  },
  ".cm-skr-slash-option-active": {
    backgroundColor: "var(--skr-accent-soft)",
  },
  ".cm-skr-slash-empty": {
    padding: "2px 8px",
    opacity: "0.6",
  },
});

/**
 * The slash menu extension. The registry supplies the items; the context
 * provider supplies command capabilities for accepted entries.
 */
export function slashMenu(
  registry: CommandRegistry,
  contextProvider: () => CommandContext,
): Extension {
  return [
    slashConfig.of({ registry, contextProvider }),
    slashMenuState,
    slashTheme,
  ];
}
