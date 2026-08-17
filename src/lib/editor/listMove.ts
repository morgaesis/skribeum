// Moving one list item to another position in the same document, expressed
// as declared spans (`{from, to, insert}` in buffer offsets) rather than a
// rewritten document, so a caller dispatches one transaction and every byte
// the move does not carry stays where the author put it. This is the shape
// `src/lib/features/tableOperations.ts` already uses for table structure.
//
// The move is a relocation, never a normalisation. An item's own bytes are
// reinserted verbatim; only the indentation and the marker character are
// rewritten, and only when the destination list writes them differently.
// Where a relocation cannot be expressed without changing a byte that is
// not part of it, the move is refused instead of approximated.
//
// Two decisions carry most of the correctness:
//
// Extent. The parser reports a `ListItem` range that stops at the item's
// last non-blank character and never covers the blank lines around it. The
// moved extent is that range widened to whole lines, plus the blank lines
// that separate the item from its next sibling; for the last item of a list
// there is no next sibling, so it carries the blank lines that separate it
// from the previous one instead. Carrying a separator either way is what
// keeps a loose list loose at both ends of the move: taking no separator
// leaves a doubled blank line behind and lands the item flush against its
// new neighbour, and taking the separator positionally rather than with the
// item rewrites gaps the author chose. An item that is the only one in its
// list carries no separator at all, because the blank lines around it
// belong to the blocks on either side, not to the item.
//
// Trailing newline. A file whose last line has no terminator cannot lose or
// gain one. Removing an extent that runs to the end of such a file consumes
// the terminator that precedes it, and inserting an extent that becomes the
// new final line emits a terminator before it instead of after it, so the
// count of line breaks is the same before and after.

import { ChangeSet, Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import {
  dominantTerminator,
  type LineEndingMap,
  type Terminator,
} from "./lineEndingMap";

/** One declared change span in buffer offsets. */
export type ListMoveChange = { from: number; to: number; insert: string };

/** Whether a list is bulleted or numbered. */
export type ListKind = "bullet" | "ordered";

/** One list item widened to the whole lines it occupies. */
export type ListItemExtent = {
  /** Offset of the first character of the item's first line. */
  from: number;
  /** Offset of the end of the item's last line, terminator excluded. */
  to: number;
  /** The leading whitespace before the item's marker. */
  indent: string;
  /** The marker source: `-`, `*`, `+`, or a number with its delimiter. */
  marker: string;
};

/** One list block and the items directly inside it. */
export type ListBlock = {
  /** Offset of the list node, the identifier a move request names. */
  from: number;
  to: number;
  kind: ListKind;
  items: ListItemExtent[];
};

/** A list and an index within it. */
export type ListPosition = {
  /** The `from` offset of the list block, as reported by `listBlocks`. */
  list: number;
  /** For a source, the item's current index; for a destination, the index
   * the item occupies once the move is done. */
  index: number;
};

export type ListMoveRequest = {
  /** The buffer text, with `\n` as the only line separator. */
  text: string;
  /** A parse of exactly that text. */
  tree: Tree;
  source: ListPosition;
  destination: ListPosition;
  /**
   * The document's on-disk terminators. Supplying them lets the move refuse
   * a relocation that would re-emit a moved line's break in another style,
   * which is the only way a mixed-ending file loses bytes here.
   */
  lineEndings?: LineEndingMap;
};

/**
 * One way of writing the insertion. The two forms put the same characters
 * in the same order in the buffer and differ only in which existing line
 * break the new one is written beside, which is what decides the terminator
 * style the conversion to bytes gives it. Attaching the insertion to the
 * end of the preceding line's content reuses that line's terminator for the
 * moved item and styles the new break after it; attaching it to the start
 * of the following line does the same with the following line's style. In a
 * file with one line-ending style the two are indistinguishable.
 */
type Insertion = { at: number; insert: string };

/** One line of the buffer: content bounds and where the next line starts. */
type DocumentLine = {
  from: number;
  /** End of the content, terminator excluded. */
  to: number;
  /** Start of the following line, or the document end when there is none. */
  next: number;
  hasBreak: boolean;
};

const LIST_KINDS = new Map<string, ListKind>([
  ["BulletList", "bullet"],
  ["OrderedList", "ordered"],
]);

/** Width of one tab stop, in columns, as CommonMark counts indentation. */
const TAB_WIDTH = 4;

/**
 * The buffer's lines. A file ending in a terminator produces no extra empty
 * line, so the result indexes one for one with a line-ending map built from
 * the same document's bytes.
 */
function documentLines(text: string): DocumentLine[] {
  const lines: DocumentLine[] = [];
  let from = 0;
  while (from <= text.length) {
    const brk = text.indexOf("\n", from);
    if (brk < 0) {
      if (from < text.length) {
        lines.push({
          from,
          to: text.length,
          next: text.length,
          hasBreak: false,
        });
      }
      break;
    }
    lines.push({ from, to: brk, next: brk + 1, hasBreak: true });
    from = brk + 1;
  }
  return lines;
}

/** The index of the line an offset starts on. */
function lineIndexAt(lines: readonly DocumentLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lines[middle]?.from ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return Math.max(0, low);
}

/**
 * The index of the line an exclusive end offset falls on. An end sitting
 * exactly at a line start belongs to the line that precedes it.
 */
function lineEndIndexAt(
  lines: readonly DocumentLine[],
  offset: number,
): number {
  const index = lineIndexAt(lines, offset);
  const line = lines[index];
  if (index > 0 && line !== undefined && line.from === offset) {
    return index - 1;
  }
  return index;
}

/** The direct list items of a list node, widened to whole lines. */
function itemsOf(
  text: string,
  lines: readonly DocumentLine[],
  list: SyntaxNode,
): ListItemExtent[] {
  const items: ListItemExtent[] = [];
  for (let child = list.firstChild; child !== null; child = child.nextSibling) {
    if (child.name !== "ListItem") {
      continue;
    }
    const first = lines[lineIndexAt(lines, child.from)];
    const last = lines[lineEndIndexAt(lines, child.to)];
    if (first === undefined || last === undefined) {
      continue;
    }
    const mark = child.firstChild;
    items.push({
      from: first.from,
      to: last.to,
      indent: text.slice(first.from, child.from),
      marker:
        mark !== null && mark.name === "ListMark"
          ? text.slice(mark.from, mark.to)
          : "",
    });
  }
  return items;
}

/**
 * Every list block in the document, outermost first, each with the items
 * directly inside it. A nested list is its own block, so an item of a
 * sublist is addressed through that sublist.
 */
export function listBlocks(text: string, tree: Tree): ListBlock[] {
  const lines = documentLines(text);
  const blocks: ListBlock[] = [];
  const pending: SyntaxNode[] = [];
  for (
    let child = tree.topNode.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    pending.push(child);
  }
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    const kind = LIST_KINDS.get(node.name);
    if (kind !== undefined) {
      blocks.push({
        from: node.from,
        to: node.to,
        kind,
        items: itemsOf(text, lines, node),
      });
    }
    for (
      let child = node.firstChild;
      child !== null;
      child = child.nextSibling
    ) {
      pending.push(child);
    }
  }
  blocks.sort((left, right) => left.from - right.from);
  return blocks;
}

/** The column a run of leading whitespace occupies, counting tab stops. */
function indentColumns(indent: string): number {
  let column = 0;
  for (const character of indent) {
    column =
      character === "\t"
        ? column + TAB_WIDTH - (column % TAB_WIDTH)
        : column + 1;
  }
  return column;
}

/** Whether the whitespace a line opens with contains a tab. */
function leadingWhitespaceHasTab(line: string): boolean {
  for (const character of line) {
    if (character === "\t") {
      return true;
    }
    if (character !== " ") {
      return false;
    }
  }
  return false;
}

/**
 * The item's source with the destination's indentation and marker
 * character, or null when that rewrite cannot be expressed without moving
 * content across a block boundary.
 *
 * Only the indentation run and the marker itself are rewritten. An ordered
 * item keeps its own number and takes only the destination's delimiter,
 * because renumbering would rewrite the numbers of items that did not move.
 * The rewrite is refused when a continuation line does not start with the
 * item's own indentation, and when changing the indentation width would
 * change what a tab inside a continuation's indentation expands to, since
 * either can turn a paragraph into an indented code block or detach a
 * sublist.
 */
function restyled(
  itemText: string,
  item: ListItemExtent,
  template: ListItemExtent,
  kind: ListKind,
): string | null {
  const indent = template.indent;
  const marker =
    kind === "bullet"
      ? template.marker
      : `${item.marker.slice(0, -1)}${template.marker.slice(-1)}`;
  if (indent === item.indent && marker === item.marker) {
    return itemText;
  }
  const shifts = indentColumns(indent) !== indentColumns(item.indent);
  const sourceLines = itemText.split("\n");
  const out: string[] = [];
  for (const [index, line] of sourceLines.entries()) {
    if (index === 0) {
      out.push(
        `${indent}${marker}${line.slice(item.indent.length + item.marker.length)}`,
      );
      continue;
    }
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    if (!line.startsWith(item.indent)) {
      return null;
    }
    const rest = line.slice(item.indent.length);
    if (shifts && leadingWhitespaceHasTab(rest)) {
      return null;
    }
    out.push(`${indent}${rest}`);
  }
  return out.join("\n");
}

/**
 * The terminator style a break inserted at `offset` is emitted in: the
 * terminator of the line the offset sits on, falling back to the document's
 * dominant style at a final line that has none. This mirrors the choice
 * `bufferEditsToChangeSet` makes when it converts the edit into bytes.
 */
function insertedTerminatorStyle(
  map: LineEndingMap,
  lines: readonly DocumentLine[],
  offset: number,
): Terminator {
  const line = map.lines[lineIndexAt(lines, offset)];
  if (line === undefined || line.terminator === "none") {
    return dominantTerminator(map);
  }
  return line.terminator;
}

/**
 * Whether every line break the move removes is written in the same style as
 * the breaks it recreates. The conversion to bytes emits an insertion's
 * breaks in one style, so a mixed-ending file can only keep every byte of
 * the moved extent when the extent and its destination already agree.
 */
function lineEndingsSurvive(
  map: LineEndingMap,
  lines: readonly DocumentLine[],
  deleteFrom: number,
  deleteTo: number,
  insertAt: number,
): boolean {
  if (map.lines.length !== lines.length) {
    return false;
  }
  const style = insertedTerminatorStyle(map, lines, insertAt);
  for (const [index, line] of lines.entries()) {
    if (!line.hasBreak || line.to < deleteFrom || line.next > deleteTo) {
      continue;
    }
    if (map.lines[index]?.terminator !== style) {
      return false;
    }
  }
  return true;
}

/**
 * The declared spans that move one list item, `[]` when the item is already
 * where it is asked to go, and null when the move is refused.
 *
 * A move is refused when either position does not name a list or an index
 * it holds, when the destination list is nested inside the item being
 * moved, when the two lists are of different kinds (turning a bullet into a
 * numbered item invents a number, which is a conversion rather than a
 * move), when re-indenting the item would change what its own continuation
 * lines mean, when the extent spans the whole document, and when the move
 * would re-emit a moved line's terminator in another style.
 */
export function moveListItem(
  request: ListMoveRequest,
): ListMoveChange[] | null {
  const { text, tree, source, destination } = request;
  const lines = documentLines(text);
  const blocks = listBlocks(text, tree);
  const sourceBlock = blocks.find((block) => block.from === source.list);
  const destinationBlock = blocks.find(
    (block) => block.from === destination.list,
  );
  if (sourceBlock === undefined || destinationBlock === undefined) {
    return null;
  }
  const item = sourceBlock.items[source.index];
  if (item === undefined) {
    return null;
  }
  const sameList = sourceBlock.from === destinationBlock.from;
  const remaining = sameList
    ? destinationBlock.items.filter((_, index) => index !== source.index)
    : destinationBlock.items;
  if (destination.index < 0 || destination.index > remaining.length) {
    return null;
  }
  if (sameList && destination.index === source.index) {
    return [];
  }
  if (remaining.length === 0) {
    return null;
  }
  if (!sameList) {
    if (sourceBlock.kind !== destinationBlock.kind) {
      return null;
    }
    if (destinationBlock.from >= item.from && destinationBlock.from < item.to) {
      return null;
    }
  }

  const startLine = lineIndexAt(lines, item.from);
  const endLine = lineEndIndexAt(lines, item.to);
  const following = sourceBlock.items[source.index + 1];
  const preceding = sourceBlock.items[source.index - 1];
  let removeStart = startLine;
  let removeEnd = endLine;
  let separator: string[] = [];
  if (following !== undefined) {
    const followingStart = lineIndexAt(lines, following.from);
    separator = lines
      .slice(endLine + 1, followingStart)
      .map((line) => text.slice(line.from, line.to));
    removeEnd = followingStart - 1;
  } else if (preceding !== undefined) {
    const precedingEnd = lineEndIndexAt(lines, preceding.to);
    separator = lines
      .slice(precedingEnd + 1, startLine)
      .map((line) => text.slice(line.from, line.to));
    removeStart = precedingEnd + 1;
  }

  const first = lines[removeStart];
  const last = lines[removeEnd];
  const itemFirst = lines[startLine];
  const itemLast = lines[endLine];
  if (
    first === undefined ||
    last === undefined ||
    itemFirst === undefined ||
    itemLast === undefined
  ) {
    return null;
  }
  const previous = lines[removeStart - 1];
  if (!last.hasBreak && previous === undefined) {
    // The extent runs to a terminatorless end of file and starts the
    // document: there is no terminator to consume and nothing to move to.
    return null;
  }
  const deleteFrom = last.hasBreak ? first.from : (previous?.to ?? first.from);
  const deleteTo = last.hasBreak ? last.next : text.length;

  const itemText = text.slice(itemFirst.from, itemLast.to);
  const template = destinationBlock.items[0];
  if (template === undefined) {
    return null;
  }
  const body = sameList
    ? itemText
    : restyled(itemText, item, template, destinationBlock.kind);
  if (body === null) {
    return null;
  }

  const gap = separator.map((line) => `${line}\n`).join("");
  const anchor = remaining[destination.index];
  const options: Insertion[] = [];
  if (anchor !== undefined) {
    const anchorLine = lineIndexAt(lines, anchor.from);
    const above = lines[anchorLine - 1];
    options.push({ at: anchor.from, insert: `${body}\n${gap}` });
    if (above?.hasBreak) {
      options.push({
        at: above.to,
        insert: `\n${body}\n${gap}`.slice(0, -1),
      });
    }
  } else {
    const tail = remaining[remaining.length - 1];
    const tailLine =
      tail === undefined ? undefined : lines[lineEndIndexAt(lines, tail.to)];
    if (tailLine === undefined) {
      return null;
    }
    if (tailLine.hasBreak) {
      options.push({ at: tailLine.next, insert: `${gap}${body}\n` });
      options.push({ at: tailLine.to, insert: `\n${gap}${body}` });
    } else {
      options.push({ at: text.length, insert: `\n${gap}${body}` });
    }
  }

  const map = request.lineEndings;
  const chosen = options.find(
    (option) =>
      !(option.at > deleteFrom && option.at < deleteTo) &&
      (map === undefined ||
        lineEndingsSurvive(map, lines, deleteFrom, deleteTo, option.at)),
  );
  if (chosen === undefined) {
    return null;
  }

  const removal: ListMoveChange = {
    from: deleteFrom,
    to: deleteTo,
    insert: "",
  };
  const addition: ListMoveChange = {
    from: chosen.at,
    to: chosen.at,
    insert: chosen.insert,
  };
  return chosen.at <= deleteFrom ? [addition, removal] : [removal, addition];
}

/** Applies declared spans to the buffer text, returning the result. */
export function applyListMove(
  text: string,
  changes: readonly ListMoveChange[],
): string {
  const doc = Text.of(text.split("\n"));
  return ChangeSet.of(
    changes.map((change) => ({ ...change })),
    doc.length,
  )
    .apply(doc)
    .toString();
}
