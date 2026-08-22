// Content authoring commands: the block constructs a person reaches for
// without knowing Markdown (headings, tasks, bullet and numbered lists,
// callouts) and the three snippets (code fence, table skeleton, wikilink).
//
// Every command is a declared-range mutation that also states where the
// caret belongs afterwards. That second half is the contract: a command
// that inserts a marker and leaves the caret where it was puts the next
// character the person types in front of the marker, which produces a line
// that is not the construct they asked for. A block command therefore
// rewrites only the marker at the start of each target line, leaves the
// line's text bytes untouched, and moves the caret with that text.

import { indentUnit } from "@codemirror/language";
import type { ChangeSpec, EditorState, Line } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

/** The block constructs a line command recognizes and writes. */
type BlockKind = "heading" | "task" | "bullet" | "ordered" | "plain";

/** A line split into the parts a block command may rewrite. */
type LineShape = {
  /** Leading whitespace, which carries list nesting depth. */
  indent: string;
  /** The recognized block marker, including the space that ends it. */
  marker: string;
  kind: BlockKind;
  /** Heading depth; zero for every other kind. */
  level: number;
  /** Everything after the marker. Never rewritten. */
  text: string;
};

/** Computes one line's new `indent + marker`, given every target line. */
type MarkerRule = (
  shape: LineShape,
  index: number,
  shapes: readonly LineShape[],
) => string;

const LEADING_WHITESPACE = /^[ \t]*/;
const HEADING_MARKER = /^(#{1,6})[ \t]+/;
// A task is a list item whose text opens with a one-character status box,
// so it has to be recognized before the plain bullet and ordered markers.
const TASK_MARKER = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[[^\]\n]\][ \t]+/;
const BULLET_MARKER = /^[-*+][ \t]+/;
const ORDERED_MARKER = /^\d{1,9}[.)][ \t]+/;
const QUOTE_MARKER = /^[ \t]{0,3}>/;
const CALLOUT_OPENING = "> [!note] ";
const QUOTE_PREFIX = "> ";
const TABLE_SKELETON = "|     |     |\n| --- | --- |\n|     |     |\n";
const MAX_HEADING_LEVEL = 6;

function shapeOf(text: string): LineShape {
  const indent = LEADING_WHITESPACE.exec(text)?.[0] ?? "";
  const rest = text.slice(indent.length);
  const heading = HEADING_MARKER.exec(rest);
  if (heading !== null) {
    return {
      indent,
      marker: heading[0],
      kind: "heading",
      level: heading[1]?.length ?? 0,
      text: rest.slice(heading[0].length),
    };
  }
  const listMarkers = [
    [TASK_MARKER, "task"],
    [BULLET_MARKER, "bullet"],
    [ORDERED_MARKER, "ordered"],
  ] as const;
  for (const [pattern, kind] of listMarkers) {
    const match = pattern.exec(rest);
    if (match !== null) {
      return {
        indent,
        marker: match[0],
        kind,
        level: 0,
        text: rest.slice(match[0].length),
      };
    }
  }
  return { indent, marker: "", kind: "plain", level: 0, text: rest };
}

/**
 * The lines a block command acts on: the caret's line, or every line the
 * selection touches. A selection ending exactly at a line start does not
 * reach into that line, matching what the person sees highlighted.
 */
function targetLines(state: EditorState): Line[] {
  const range = state.selection.main;
  let line = state.doc.lineAt(range.from);
  const lines: Line[] = [line];
  while (line.to < range.to) {
    const next = state.doc.lineAt(line.to + 1);
    if (next.from >= range.to) {
      break;
    }
    lines.push(next);
    line = next;
  }
  return lines;
}

function everyLineIs(shapes: readonly LineShape[], kind: BlockKind): boolean {
  return shapes.every((shape) => shape.kind === kind);
}

/**
 * Rewrites the block marker of every target line and places the caret by
 * intent rather than by arithmetic on the old position: a position inside
 * the marker (which includes the start of an empty line) lands at the end
 * of the new marker, so the next character typed is the first character of
 * the construct; a position in the line's text keeps its place in that
 * text.
 */
function rewriteMarkers(view: EditorView, rule: MarkerRule): boolean {
  const state = view.state;
  if (state.readOnly) {
    return false;
  }
  const lines = targetLines(state);
  const shapes = lines.map((line) => shapeOf(line.text));
  const markers = shapes.map((shape, index) => rule(shape, index, shapes));
  const changes: ChangeSpec[] = [];
  for (const [index, line] of lines.entries()) {
    const shape = shapes[index];
    const marker = markers[index];
    if (shape === undefined || marker === undefined) {
      continue;
    }
    const to = line.from + shape.indent.length + shape.marker.length;
    if (state.doc.sliceString(line.from, to) !== marker) {
      changes.push({ from: line.from, to, insert: marker });
    }
  }
  const mapPosition = (position: number): number => {
    let shift = 0;
    for (const [index, line] of lines.entries()) {
      const shape = shapes[index];
      const marker = markers[index];
      if (shape === undefined || marker === undefined || position < line.from) {
        break;
      }
      const markerEnd = line.from + shape.indent.length + shape.marker.length;
      if (position <= markerEnd) {
        return line.from + shift + marker.length;
      }
      shift += marker.length - (markerEnd - line.from);
    }
    return position + shift;
  };
  const range = state.selection.main;
  view.dispatch({
    changes,
    selection: range.empty
      ? EditorSelection.cursor(mapPosition(range.head))
      : EditorSelection.range(
          mapPosition(range.anchor),
          mapPosition(range.head),
        ),
    scrollIntoView: true,
    userEvent: "input.insert",
  });
  return true;
}

/**
 * Sets the target lines to one heading level, replacing whatever block
 * marker they carried, so a heading command on a list line yields a
 * heading rather than a heading whose text opens with a bullet. Running it
 * on lines that already are that heading removes the heading, which is the
 * only route back to a paragraph for someone who does not write Markdown.
 */
function headingRule(level: number): MarkerRule {
  const marker = `${"#".repeat(level)} `;
  return (shape, _index, shapes) =>
    shapes.every((entry) => entry.kind === "heading" && entry.level === level)
      ? shape.indent
      : marker;
}

/** Sets or, when every target line already carries it, clears one list kind. */
function listRule(kind: "task" | "bullet" | "ordered"): MarkerRule {
  return (shape, index, shapes) => {
    if (everyLineIs(shapes, kind)) {
      return shape.indent;
    }
    switch (kind) {
      case "task":
        return `${shape.indent}- [ ] `;
      case "bullet":
        return `${shape.indent}- `;
      case "ordered":
        return `${shape.indent}${index + 1}. `;
    }
  };
}

/**
 * Wraps the target lines in a callout. There is always a title line, and
 * the caret lands on it: an empty title is what the person came to type,
 * and consuming their first paragraph as the title would be a surprise.
 * A blank target needs no body, so it becomes the title line alone.
 */
function insertCallout(view: EditorView): boolean {
  const state = view.state;
  if (state.readOnly) {
    return false;
  }
  const lines = targetLines(state);
  const first = lines[0];
  if (first === undefined) {
    return false;
  }
  if (lines.length === 1 && first.text.trim().length === 0) {
    view.dispatch({
      changes: { from: first.from, to: first.to, insert: CALLOUT_OPENING },
      selection: EditorSelection.cursor(first.from + CALLOUT_OPENING.length),
      scrollIntoView: true,
      userEvent: "input.insert",
    });
    return true;
  }
  const changes: ChangeSpec[] = [
    { from: first.from, to: first.from, insert: `${CALLOUT_OPENING}\n` },
  ];
  for (const line of lines) {
    if (!QUOTE_MARKER.test(line.text)) {
      changes.push({ from: line.from, to: line.from, insert: QUOTE_PREFIX });
    }
  }
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(first.from + CALLOUT_OPENING.length),
    scrollIntoView: true,
    userEvent: "input.insert",
  });
  return true;
}

/** Moves every target heading by `delta` levels, declining outside headings. */
function changeHeadingLevel(view: EditorView, delta: number): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const shapes = targetLines(view.state).map((line) => shapeOf(line.text));
  if (!shapes.some((shape) => shape.kind === "heading")) {
    return false;
  }
  return rewriteMarkers(view, (shape) => {
    if (shape.kind !== "heading") {
      return shape.indent + shape.marker;
    }
    const level = Math.min(MAX_HEADING_LEVEL, Math.max(1, shape.level + delta));
    return `${"#".repeat(level)} `;
  });
}

function withoutOneIndentStep(indent: string, unit: string): string {
  if (indent.startsWith(unit)) {
    return indent.slice(unit.length);
  }
  if (indent.startsWith("\t")) {
    return indent.slice(1);
  }
  const spaces = /^ */.exec(indent)?.[0].length ?? 0;
  return indent.slice(Math.min(spaces, unit.length));
}

/**
 * Nests or un-nests every target list line by one indentation step,
 * declining when no target line is a list so the binding falls through to
 * whatever else claims the key.
 */
function changeListIndent(view: EditorView, delta: 1 | -1): boolean {
  const state = view.state;
  if (state.readOnly) {
    return false;
  }
  const shapes = targetLines(state).map((line) => shapeOf(line.text));
  const listKinds: readonly BlockKind[] = ["task", "bullet", "ordered"];
  if (!shapes.some((shape) => listKinds.includes(shape.kind))) {
    return false;
  }
  const unit = state.facet(indentUnit);
  return rewriteMarkers(view, (shape) => {
    if (!listKinds.includes(shape.kind)) {
      return shape.indent + shape.marker;
    }
    const indent =
      delta === 1
        ? unit + shape.indent
        : withoutOneIndentStep(shape.indent, unit);
    return indent + shape.marker;
  });
}

/**
 * Tab and Shift-Tab nest and unnest a list item when the caret sits at the
 * item's text start, the one position where indentation is what the key
 * means. Everywhere else both keys fall through to the browser's focus
 * order, so the editor never becomes a keyboard trap: a caret in prose
 * tabs out, a caret mid-sentence in a list tabs out, and only the exact
 * spot every peer editor treats as "nest this item" indents.
 */
export function listTabIndent(delta: 1 | -1) {
  return (view: EditorView): boolean => {
    const state = view.state;
    const range = state.selection.main;
    if (!range.empty || state.readOnly) {
      return false;
    }
    const line = state.doc.lineAt(range.head);
    const shape = shapeOf(line.text);
    if (!["task", "bullet", "ordered"].includes(shape.kind)) {
      return false;
    }
    const textStart = line.from + shape.indent.length + shape.marker.length;
    if (range.head !== textStart) {
      return false;
    }
    return changeListIndent(view, delta);
  };
}

/**
 * Inserts a snippet at the caret with the caret placed inside it, at
 * `cursorOffset` characters from the snippet's start.
 */
function insertSnippet(
  view: EditorView,
  text: string,
  cursorOffset: number,
): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + cursorOffset),
    scrollIntoView: true,
    userEvent: "input.insert",
  });
  return true;
}

/** Registers the content insertion and line restructuring commands. */
export function registerInsertions(registry: CommandRegistry): void {
  const blockCommands: readonly {
    id: string;
    title: string;
    shortLabel: string;
    rule: MarkerRule;
    keywords: readonly string[];
  }[] = [
    {
      id: "insert.heading-1",
      title: STRINGS.insertHeading1,
      shortLabel: STRINGS.slashHeading1,
      rule: headingRule(1),
      keywords: ["h1", "title"],
    },
    {
      id: "insert.heading-2",
      title: STRINGS.insertHeading2,
      shortLabel: STRINGS.slashHeading2,
      rule: headingRule(2),
      keywords: ["h2"],
    },
    {
      id: "insert.heading-3",
      title: STRINGS.insertHeading3,
      shortLabel: STRINGS.slashHeading3,
      rule: headingRule(3),
      keywords: ["h3"],
    },
    {
      id: "insert.task",
      title: STRINGS.insertTask,
      shortLabel: STRINGS.slashTask,
      rule: listRule("task"),
      keywords: ["todo", "checkbox"],
    },
    {
      id: "insert.bullet-list",
      title: STRINGS.insertBulletList,
      shortLabel: STRINGS.slashBulletList,
      rule: listRule("bullet"),
      keywords: ["bullet", "list", "unordered", "point"],
    },
    {
      id: "insert.numbered-list",
      title: STRINGS.insertNumberedList,
      shortLabel: STRINGS.slashNumberedList,
      rule: listRule("ordered"),
      keywords: ["numbered", "ordered", "list", "steps"],
    },
  ];
  for (const entry of blockCommands) {
    registry.register({
      id: entry.id,
      title: entry.title,
      scope: "editor",
      pointer: ["command-palette", "slash-menu"],
      slash: { keywords: entry.keywords, label: entry.shortLabel },
      searchTerms: entry.keywords,
      run: (context) =>
        context.view === null
          ? false
          : rewriteMarkers(context.view, entry.rule),
    });
  }
  registry.register({
    id: "insert.callout",
    title: STRINGS.insertCallout,
    scope: "editor",
    pointer: ["command-palette", "slash-menu"],
    slash: { keywords: ["note", "admonition"], label: STRINGS.slashCallout },
    searchTerms: ["note", "admonition", "quote"],
    run: (context) =>
      context.view === null ? false : insertCallout(context.view),
  });
  registry.register({
    id: "heading.increase-level",
    title: STRINGS.headingIncreaseLevel,
    scope: "editor",
    pointer: ["command-palette"],
    searchTerms: ["demote", "smaller heading", "heading level"],
    run: (context) =>
      context.view === null ? false : changeHeadingLevel(context.view, 1),
  });
  registry.register({
    id: "heading.decrease-level",
    title: STRINGS.headingDecreaseLevel,
    scope: "editor",
    pointer: ["command-palette"],
    searchTerms: ["promote", "bigger heading", "heading level"],
    run: (context) =>
      context.view === null ? false : changeHeadingLevel(context.view, -1),
  });
  registry.register({
    id: "list.indent",
    title: STRINGS.listIndent,
    keybindings: ["Mod-]"],
    scope: "editor",
    pointer: ["command-palette"],
    searchTerms: ["demote", "nest", "sublist"],
    run: (context) =>
      context.view === null ? false : changeListIndent(context.view, 1),
  });
  registry.register({
    id: "list.outdent",
    title: STRINGS.listOutdent,
    keybindings: ["Mod-["],
    scope: "editor",
    pointer: ["command-palette"],
    searchTerms: ["promote", "unnest", "outdent"],
    run: (context) =>
      context.view === null ? false : changeListIndent(context.view, -1),
  });
  registry.register({
    id: "insert.code-fence",
    title: STRINGS.insertCodeFence,
    scope: "editor",
    pointer: ["command-palette", "slash-menu"],
    slash: {
      keywords: ["code", "fence", "block"],
      label: STRINGS.slashCodeFence,
    },
    run: (context) =>
      context.view === null
        ? false
        : insertSnippet(context.view, "```\n\n```", 4),
  });
  registry.register({
    id: "insert.table",
    title: STRINGS.insertTable,
    scope: "editor",
    pointer: ["command-palette", "slash-menu"],
    slash: { keywords: ["table", "grid"], label: STRINGS.slashTable },
    run: (context) =>
      context.view === null
        ? false
        : insertSnippet(context.view, TABLE_SKELETON, 2),
  });
  registry.register({
    id: "insert.wikilink",
    title: STRINGS.insertWikilink,
    scope: "editor",
    pointer: ["command-palette", "slash-menu"],
    slash: { keywords: ["link", "note"], label: STRINGS.slashWikilink },
    run: (context) =>
      context.view === null ? false : insertSnippet(context.view, "[[]]", 2),
  });
}
