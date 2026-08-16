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
import { matchTags, segmentByPositions } from "../fuzzy";
import { enterMotionSurface } from "../motion";
import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

export type TagCatalogEntry = {
  /** Tag text without the leading hash. */
  tag: string;
  /**
   * Notes containing the tag or a tag below it in the path, counted once
   * each: the same set a query for the tag returns.
   */
  noteCount: number;
  /** Occurrences of the tag and of every tag below it, across the vault. */
  occurrenceCount: number;
};

export type TagAffordanceOptions = {
  /** Returns the latest tag catalog for the open vault. */
  catalog(): readonly TagCatalogEntry[];
  /** Recently used tags, most recent first. */
  recentTags(): readonly string[];
  /** Opens note-text mode filtered to this tag. */
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
// `*` is accepted and then stripped, so a reader who reaches for a wildcard
// keeps the menu they already had instead of losing it mid-word.
const TAG_QUERY = /^[\p{L}\p{N}\p{M}_/*-]*$/u;
const TAG_QUERY_LIMIT = 512;
/**
 * Rows the menu ever renders. A caret-anchored menu is capped at 12rem of
 * height regardless, so a longer list has a tail nobody can read, and the
 * answer to "there are more" here is that the reader is mid-word and about
 * to narrow it anyway.
 */
const TAG_COMPLETION_LIMIT = 8;

function triggerAt(state: EditorState, position: number): boolean {
  if (position === 0) {
    return true;
  }
  return /\s/u.test(state.doc.sliceString(position - 1, position));
}

/**
 * The hash position of the tag query the cursor currently sits inside, or
 * null. Scanning back from the cursor is what lets the menu re-open after a
 * character that ended the query is deleted; arming only on a typed `#` left
 * the reader having to delete past the hash and type it again.
 */
function queryStartBefore(state: EditorState): number | null {
  const head = state.selection.main.head;
  if (!state.selection.main.empty) {
    return null;
  }
  const from = Math.max(0, head - (TAG_QUERY_LIMIT + 1));
  const text = state.doc.sliceString(from, head);
  const hash = text.lastIndexOf("#");
  if (hash < 0) {
    return null;
  }
  const start = from + hash;
  return triggerAt(state, start) && TAG_QUERY.test(text.slice(hash + 1))
    ? start
    : null;
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
      (transaction.isUserEvent("input.type") ||
        transaction.isUserEvent("delete"))
    ) {
      const from = queryStartBefore(transaction.state);
      if (from !== null) {
        next = { from, selected: 0 };
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

/** One completion row: the tag and the span of it the query matched. */
export type TagCompletion = TagCatalogEntry & {
  /** `[from, to)` over the tag text, or null when nothing is marked. */
  highlight: readonly [number, number] | null;
};

/**
 * Filters and ranks tag completions, sharing the command surface's band
 * ordering with two divergences the menu's job requires.
 *
 * The exact match is present and is the first row. Accepting it is not a
 * no-op: it normalizes to the vault's existing spelling and confirms the tag
 * exists. Excluding it reported that a correctly typed, heavily used tag did
 * not exist, and left Enter committing whichever neighbouring tag happened to
 * sort first.
 *
 * Near matches are excluded entirely. Offering a typo-adjacent tag to someone
 * who is authoring invites inserting the wrong tag into a note, which is a
 * durable error rather than a wasted keystroke: search tolerates typos,
 * authoring must not propose them.
 *
 * Recency is the first tiebreak inside a band, so a tag used in this session
 * comes before an equally relevant one that was not.
 */
export function filteredTagCompletions(
  catalog: readonly TagCatalogEntry[],
  recentTags: readonly string[],
  query: string,
): TagCompletion[] {
  const recentRanks = new Map(
    recentTags.map((tag, index) => [normalizedTag(tag).toLowerCase(), index]),
  );
  const { primary } = matchTags(
    catalog.map((entry) => ({ ...entry, tag: normalizedTag(entry.tag) })),
    query,
    {
      nearMatches: false,
      limit: TAG_COMPLETION_LIMIT,
      recencyOf: (tag) =>
        recentRanks.get(tag.toLowerCase()) ?? Number.POSITIVE_INFINITY,
    },
  );
  return primary.map(({ entry, highlight }) => ({ ...entry, highlight }));
}

/** Whether the tag completion menu is open. */
export function tagCompletionOpen(state: EditorState): boolean {
  return state.field(tagCompletionState, false) != null;
}

function completionItems(
  state: EditorState,
  open: TagMenuState,
): readonly TagCompletion[] {
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
    return false;
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
  // Clamping rather than wrapping, so the same gesture behaves the same way
  // here and in the command surface.
  const selected = Math.max(
    0,
    Math.min(Math.min(open.selected, count - 1) + delta, count - 1),
  );
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
    pointer: ["command-palette", "editor-tag"],
    run: (context) =>
      context.view === null ? false : searchTagUnderCursor(context.view),
  });
  registry.register({
    id: "tag.next",
    title: STRINGS.tagMenuLabel,
    keybindings: ["ArrowDown"],
    scope: "editor",
    palette: false,
    audience: "widget",
    run: (context) =>
      context.view === null ? false : moveSelection(context.view, 1),
  });
  registry.register({
    id: "tag.previous",
    title: STRINGS.tagMenuLabel,
    keybindings: ["ArrowUp"],
    scope: "editor",
    palette: false,
    audience: "widget",
    run: (context) =>
      context.view === null ? false : moveSelection(context.view, -1),
  });
  registry.register({
    id: "tag.accept",
    title: STRINGS.tagMenuLabel,
    keybindings: ["Enter", "Ctrl-Enter"],
    scope: "editor",
    palette: false,
    audience: "widget",
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
    audience: "widget",
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
      dom.dataset.motionSurface = "anchored-top";
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
          // Marking the typed span answers "why is this row here", and the
          // segments are real text nodes so no markup can be injected.
          const positions: number[] = [];
          if (item.highlight !== null) {
            for (
              let offset = item.highlight[0];
              offset < item.highlight[1];
              offset += 1
            ) {
              positions.push(offset + 1);
            }
          }
          for (const segment of segmentByPositions(`#${item.tag}`, positions)) {
            if (segment.highlighted) {
              const mark = document.createElement("mark");
              mark.className = "skr-match";
              mark.textContent = segment.text;
              option.append(mark);
            } else {
              option.append(document.createTextNode(segment.text));
            }
          }
          option.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            view.dispatch({ effects: setSelected.of(index) });
            acceptItem(view);
          });
          dom.append(option);
        }
      };
      render(view.state);
      enterMotionSurface(dom);
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
    maxHeight: "12rem",
    overflowY: "auto",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    border: "1px solid var(--skr-border)",
    borderRadius: "var(--skr-radius-surface)",
    boxShadow: "var(--skr-shadow)",
  },
  ".cm-skr-tag-option": {
    padding: "2px 8px",
    borderRadius: "var(--skr-radius-control)",
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
