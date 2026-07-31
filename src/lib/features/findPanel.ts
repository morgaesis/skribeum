// In-note find and replace over `@codemirror/search`, configured through
// the registry: the `find.*` commands own every keybinding, the panel is
// a custom build with a live match count, and replace-one and
// replace-all dispatch ordinary transactions, so replacements flow
// through the normal change-set save path.

import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import {
  type EditorView,
  type Panel,
  EditorView as View,
} from "@codemirror/view";
import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

const MATCH_COUNT_LIMIT = 999;

/** Counts query matches over the document, capped for responsiveness. */
export function countMatches(view: EditorView): number {
  const query = getSearchQuery(view.state);
  if (query.search.length === 0 || !query.valid) {
    return 0;
  }
  const cursor = query.getCursor(view.state);
  let count = 0;
  while (count < MATCH_COUNT_LIMIT) {
    const step = cursor.next();
    if (step.done === true) {
      break;
    }
    count += 1;
  }
  return count;
}

function matchCountText(count: number): string {
  if (count === 0) {
    return STRINGS.noMatches;
  }
  const noun =
    count === 1 ? STRINGS.findMatchSingular : STRINGS.findMatchPlural;
  return `${count}${count >= MATCH_COUNT_LIMIT ? "+" : ""} ${noun}`;
}

function button(label: string, text: string, onPress: () => void): HTMLElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cm-skr-find-button";
  element.setAttribute("aria-label", label);
  element.title = label;
  element.textContent = text;
  element.addEventListener("mousedown", (event) => {
    event.preventDefault();
    onPress();
  });
  return element;
}

function buildFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-skr-find-panel";
  dom.setAttribute("role", "search");
  dom.setAttribute("aria-label", STRINGS.commandFindInNote);

  const findInput = document.createElement("input");
  findInput.type = "text";
  findInput.className = "cm-skr-find-input";
  findInput.placeholder = STRINGS.findPlaceholder;
  findInput.setAttribute("aria-label", STRINGS.findPlaceholder);
  findInput.value = getSearchQuery(view.state).search;

  const count = document.createElement("span");
  count.className = "cm-skr-find-count";
  count.setAttribute("aria-live", "polite");

  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.className = "cm-skr-find-input";
  replaceInput.placeholder = STRINGS.replacePlaceholder;
  replaceInput.setAttribute("aria-label", STRINGS.replacePlaceholder);

  const refreshCount = () => {
    count.textContent = matchCountText(countMatches(view));
  };

  const pushQuery = () => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: findInput.value,
          replace: replaceInput.value,
          caseSensitive: false,
          literal: true,
        }),
      ),
    });
    refreshCount();
  };

  findInput.addEventListener("input", pushQuery);
  replaceInput.addEventListener("input", pushQuery);
  // registry-exempt keydown: panel-internal keys of the find widget
  // (Enter advances, Shift-Enter reverses, Escape closes and returns
  // focus), scoped to its own inputs per the search-pattern equivalent of
  // widget-internal navigation; the chords that reach this panel are all
  // registry commands.
  const panelKeys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      findNext(view);
    } else if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      findPrevious(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };
  findInput.addEventListener("keydown", panelKeys);
  replaceInput.addEventListener("keydown", panelKeys);

  dom.append(
    findInput,
    count,
    button(STRINGS.findPreviousLabel, "↑", () => findPrevious(view)),
    button(STRINGS.findNextLabel, "↓", () => findNext(view)),
    replaceInput,
    button(STRINGS.replaceOneLabel, STRINGS.replaceOneLabel, () => {
      replaceNext(view);
      refreshCount();
    }),
    button(STRINGS.replaceAllLabel, STRINGS.replaceAllLabel, () => {
      replaceAll(view);
      refreshCount();
    }),
    button(STRINGS.findCloseLabel, "×", () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );
  refreshCount();

  return {
    dom,
    top: true,
    mount: () => {
      findInput.focus();
      findInput.select();
    },
    update: (update) => {
      if (update.docChanged) {
        refreshCount();
      }
    },
  };
}

const findTheme = View.baseTheme({
  ".cm-skr-find-panel": {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px",
  },
  ".cm-skr-find-input": {
    border: "1px solid var(--skr-border)",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    borderRadius: "4px",
    padding: "1px 6px",
    font: "inherit",
  },
  ".cm-skr-find-count": {
    fontSize: "0.85em",
    opacity: "0.7",
    minWidth: "5em",
  },
  ".cm-skr-find-button": {
    border: "1px solid var(--skr-border)",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface)",
    borderRadius: "4px",
    padding: "1px 6px",
    cursor: "pointer",
  },
});

/** The find extension with the custom panel. */
export function findExtension(): Extension {
  return [search({ createPanel: buildFindPanel, top: true }), findTheme];
}

/** Registers the find commands and their keybindings. */
export function registerFind(registry: CommandRegistry): void {
  registry.register({
    id: "find.open",
    title: STRINGS.commandFindInNote,
    keybindings: ["Mod-f"],
    scope: "editor",
    run: (context) =>
      context.view === null ? false : openSearchPanel(context.view),
  });
  registry.register({
    id: "find.next",
    title: STRINGS.commandFindNext,
    keybindings: ["Mod-g"],
    scope: "editor",
    run: (context) => (context.view === null ? false : findNext(context.view)),
  });
  registry.register({
    id: "find.previous",
    title: STRINGS.commandFindPrevious,
    keybindings: ["Mod-Shift-g"],
    scope: "editor",
    run: (context) =>
      context.view === null ? false : findPrevious(context.view),
  });
  registry.register({
    id: "find.close",
    title: STRINGS.findCloseLabel,
    keybindings: ["Escape"],
    scope: "editor",
    palette: false,
    run: (context) => {
      const view = context.view;
      if (view === null || !searchPanelOpen(view.state)) {
        return false;
      }
      closeSearchPanel(view);
      return true;
    },
  });
}
