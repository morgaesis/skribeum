// Tag search and completion share one editor-local capability provider.
// Pointer activation, the palette command, and the inline completion menu
// therefore use the same vault catalog and existing search callback.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  type EditorView,
  showTooltip,
  type Tooltip,
  EditorView as View,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { fuzzyMatch } from "../fuzzy";
import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

export type TagCatalogEntry = {
  /** Tag text without the leading hash. */
  tag: string;
  /** Number of notes containing the tag. */
  noteCount: number;
  /** Total number of tag occurrences across the vault. */
  occurrenceCount: number;
};

export type TagAffordanceOptions = {
  /** Returns the latest tag catalog for the open vault. */
  catalog(): readonly TagCatalogEntry[];
  /** Recently used tags, most recent first. */
  recentTags(): readonly string[];
  /** Opens the existing vault search surface for this tag. */
  search(tag: string): void;
  /** Records a tag selected from completion. */
  remember(tag: string): void;
};

type TagMenuState = {
  /** Position of the hash character. */
  from: number;
  /** Index into the filtered completion list. */
  selected: number;
};

type TagConfig = {
  options: () => TagAffordanceOptions;
};

const tagConfig = Facet.define<TagConfig, TagConfig | null>({
  combine: (values) => values[0] ?? null,
});

const setSelected = StateEffect.define<number>();
const closeMenu = StateEffect.define<null>();
const TAG_QUERY = /^[\p{L}\p{N}\p{M}_/-]*$/u;
const TAG_QUERY_LIMIT = 512;

function triggerAt(state: EditorState, position: number): boolean {
  if (position === 0) {
    return true;
  }
  return /\s/u.test(state.doc.sliceString(position - 1, position));
}

function queryOf(state: EditorState, open: TagMenuState): string | null {
  const head = state.selection.main.head;
  if (!state.selection.main.empty || head < open.from + 1) {
    return null;
  }
  if (state.doc.sliceString(open.from, open.from + 1) !== "#") {
    return null;
  }
  const query = state.doc.sliceString(open.from + 1, head);
  return query.length <= TAG_QUERY_LIMIT && TAG_QUERY.test(query)
    ? query
    : null;
}

export const tagCompletionState = StateField.define<TagMenuState | null>({
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
          inserted.toString() === "#" &&
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
      return open === null ? null : tagTooltip(open);
    }),
});

function normalizedTag(tag: string): string {
  return tag.startsWith("#") ? tag.slice(1) : tag;
}

/**
 * Filters and ranks tag completions. Fuzzy score is the primary order,
 * followed by recent usage, note count, occurrence count, and locale. An
 * empty query gives every tag the same fuzzy score, so recency and frequency
 * surface established tags before rare ones.
 */
export function filteredTagCompletions(
  catalog: readonly TagCatalogEntry[],
  recentTags: readonly string[],
  query: string,
): TagCatalogEntry[] {
  const recentRanks = new Map(
    recentTags.map((tag, index) => [
      normalizedTag(tag).toLocaleLowerCase(),
      index,
    ]),
  );
  const seen = new Set<string>();
  return catalog
    .map((entry) => {
      const tag = normalizedTag(entry.tag);
      const normalized = tag.toLocaleLowerCase();
      const match = fuzzyMatch(query, tag);
      return {
        entry: { ...entry, tag },
        match,
        recentRank: recentRanks.get(normalized) ?? Number.POSITIVE_INFINITY,
        normalized,
      };
    })
    .filter((ranked) => {
      if (ranked.match === null || seen.has(ranked.normalized)) {
        return false;
      }
      seen.add(ranked.normalized);
      return true;
    })
    .sort((left, right) => {
      const score = (right.match?.score ?? 0) - (left.match?.score ?? 0);
      if (score !== 0) {
        return score;
      }
      if (left.recentRank !== right.recentRank) {
        return left.recentRank < right.recentRank ? -1 : 1;
      }
      const notes = right.entry.noteCount - left.entry.noteCount;
      if (notes !== 0) {
        return notes;
      }
      const occurrences =
        right.entry.occurrenceCount - left.entry.occurrenceCount;
      if (occurrences !== 0) {
        return occurrences;
      }
      return left.entry.tag.localeCompare(right.entry.tag);
    })
    .map((ranked) => ranked.entry);
}

/** Whether the tag completion menu is open. */
export function tagCompletionOpen(state: EditorState): boolean {
  return state.field(tagCompletionState, false) != null;
}

function completionItems(
  state: EditorState,
  open: TagMenuState,
): readonly TagCatalogEntry[] {
  const config = state.facet(tagConfig);
  if (config === null) {
    return [];
  }
  const options = config.options();
  return filteredTagCompletions(
    options.catalog(),
    options.recentTags(),
    queryOf(state, open) ?? "",
  );
}

function acceptItem(view: EditorView): boolean {
  const open = view.state.field(tagCompletionState, false);
  const config = view.state.facet(tagConfig);
  if (open == null || config === null) {
    return false;
  }
  const items = completionItems(view.state, open);
  const item = items[Math.min(open.selected, items.length - 1)];
  if (item === undefined) {
    return true;
  }
  view.dispatch({
    changes: {
      from: open.from,
      to: view.state.selection.main.head,
      insert: `#${item.tag}`,
    },
    effects: closeMenu.of(null),
    userEvent: "input.tag",
  });
  config.options().remember(item.tag);
  return true;
}

function moveSelection(view: EditorView, delta: number): boolean {
  const open = view.state.field(tagCompletionState, false);
  if (open == null) {
    return false;
  }
  const count = completionItems(view.state, open).length;
  if (count === 0) {
    return true;
  }
  const selected = (open.selected + delta + count) % count;
  view.dispatch({ effects: setSelected.of(selected) });
  return true;
}

function closeAndRemoveQuery(view: EditorView): boolean {
  const open = view.state.field(tagCompletionState, false);
  if (open == null) {
    return false;
  }
  view.dispatch({
    changes: {
      from: open.from,
      to: view.state.selection.main.head,
      insert: "",
    },
    effects: closeMenu.of(null),
    userEvent: "input.tag",
  });
  return true;
}

function hashTagNodeAt(
  state: EditorState,
  position: number,
): SyntaxNode | null {
  for (const bias of [-1, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(
      position,
      bias,
    );
    while (node !== null) {
      if (node.name === "HashTag") {
        return node;
      }
      node = node.parent;
    }
  }
  return null;
}

/** Returns the tag under the primary cursor without its leading hash. */
export function tagUnderCursor(view: EditorView): string | null {
  const node = hashTagNodeAt(view.state, view.state.selection.main.head);
  return node === null
    ? null
    : view.state.doc.sliceString(node.from + 1, node.to);
}

function searchTagUnderCursor(view: EditorView): boolean {
  const config = view.state.facet(tagConfig);
  const tag = tagUnderCursor(view);
  if (config === null || tag === null) {
    return false;
  }
  config.options().search(tag);
  return true;
}

/** Registers tag search and completion commands. */
export function registerTags(registry: CommandRegistry): void {
  registry.register({
    id: "tag.search-under-cursor",
    title: STRINGS.commandSearchTag,
    scope: "editor",
    run: (context) =>
      context.view === null ? false : searchTagUnderCursor(context.view),
  });
  registry.register({
    id: "tag.next",
    title: STRINGS.tagMenuLabel,
    keybindings: ["ArrowDown"],
    scope: "editor",
    palette: false,
    run: (context) =>
      context.view === null ? false : moveSelection(context.view, 1),
  });
  registry.register({
    id: "tag.previous",
    title: STRINGS.tagMenuLabel,
    keybindings: ["ArrowUp"],
    scope: "editor",
    palette: false,
    run: (context) =>
      context.view === null ? false : moveSelection(context.view, -1),
  });
  registry.register({
    id: "tag.accept",
    title: STRINGS.tagMenuLabel,
    keybindings: ["Enter", "Ctrl-Enter"],
    scope: "editor",
    palette: false,
    run: (context) =>
      context.view === null || !tagCompletionOpen(context.view.state)
        ? false
        : acceptItem(context.view),
  });
  registry.register({
    id: "tag.close",
    title: STRINGS.tagMenuLabel,
    keybindings: ["Escape"],
    scope: "editor",
    palette: false,
    run: (context) =>
      context.view === null ? false : closeAndRemoveQuery(context.view),
  });
}

function tagTooltip(open: TagMenuState): Tooltip {
  return {
    pos: open.from,
    above: false,
    create: (view) => {
      const dom = document.createElement("ul");
      dom.className = "cm-skr-tag-menu";
      dom.setAttribute("role", "listbox");
      dom.setAttribute("aria-label", STRINGS.tagMenuLabel);
      const render = (state: EditorState) => {
        const current = state.field(tagCompletionState, false);
        dom.replaceChildren();
        if (current == null) {
          return;
        }
        const items = completionItems(state, current);
        if (items.length === 0) {
          const empty = document.createElement("li");
          empty.className = "cm-skr-tag-empty";
          empty.textContent = STRINGS.noMatches;
          dom.append(empty);
          return;
        }
        const selected = Math.min(current.selected, items.length - 1);
        for (const [index, item] of items.entries()) {
          const option = document.createElement("li");
          option.setAttribute("role", "option");
          option.id = `skr-tag-option-${index}`;
          option.setAttribute(
            "aria-selected",
            index === selected ? "true" : "false",
          );
          option.className =
            index === selected
              ? "cm-skr-tag-option cm-skr-tag-option-active"
              : "cm-skr-tag-option";
          option.textContent = `#${item.tag}`;
          option.addEventListener("pointerdown", (event) => {
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
        update: (update) => render(update.state),
      };
    },
  };
}

const tagTheme = View.baseTheme({
  ".cm-skr-tag-menu": {
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
  ".cm-skr-tag-option": {
    padding: "2px 8px",
    borderRadius: "4px",
    cursor: "pointer",
  },
  ".cm-skr-tag-option-active": {
    backgroundColor: "var(--skr-accent-subtle)",
  },
  ".cm-skr-tag-empty": {
    padding: "2px 8px",
    color: "var(--skr-text-muted)",
  },
});

function tagPointerSearch(options: () => TagAffordanceOptions): Extension {
  let pointerHandled = false;
  const activation = (view: EditorView, target: EventTarget | null) => {
    const element =
      target instanceof Element
        ? target.closest<HTMLElement>(".cm-skr-tag[data-tag]")
        : null;
    return element !== null && view.dom.contains(element)
      ? element.dataset.tag
      : undefined;
  };
  return Prec.high(
    View.domEventHandlers({
      mousedown(event, view) {
        pointerHandled = false;
        if (event.button !== 0 || event.altKey || event.shiftKey) {
          return false;
        }
        const tag = activation(view, event.target);
        if (tag === undefined) {
          return false;
        }
        event.preventDefault();
        options().search(tag);
        pointerHandled = true;
        return true;
      },
      click(event, view) {
        if (event.button !== 0 || event.altKey || event.shiftKey) {
          pointerHandled = false;
          return false;
        }
        const tag = activation(view, event.target);
        if (tag === undefined) {
          pointerHandled = false;
          return false;
        }
        event.preventDefault();
        if (!pointerHandled) {
          options().search(tag);
        }
        pointerHandled = false;
        return true;
      },
      keydown(event, view) {
        if (event.key !== "Enter") {
          return false;
        }
        const tag = activation(view, event.target);
        if (tag === undefined) {
          return false;
        }
        event.preventDefault();
        options().search(tag);
        return true;
      },
    }),
  );
}

/**
 * Installs pointer tag search and the slash-style text-triggered completion
 * tooltip. Commands are supplied separately by `registerTags`.
 */
export function tagAffordances(options: () => TagAffordanceOptions): Extension {
  return [
    tagConfig.of({ options }),
    tagCompletionState,
    tagPointerSearch(options),
    tagTheme,
  ];
}
