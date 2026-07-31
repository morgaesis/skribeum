// Pure GFM table editing over a table block's source text. Every
// operation returns declared spans (`{from, to, insert}` in character
// offsets within the block): a structural change (a new row or column)
// composed with the formatting pass that re-pads other cells, so each
// touched byte, including padding in cells the operation did not target,
// is inside a declared range. The M1b containment property is asserted
// over exactly these spans.

import { ChangeSet, Text } from "@codemirror/state";

/** One declared change span within the table block text. */
export type TableSpanChange = { from: number; to: number; insert: string };

export type TableOperation =
  | { kind: "insert-row"; line: number; position: "above" | "below" }
  | { kind: "insert-column"; column: number; position: "before" | "after" };

export type ColumnAlignment = "none" | "left" | "center" | "right";

/** One cell's span within its line, pipes excluded, spaces included. */
type CellSpan = { from: number; to: number };

type ParsedLine = {
  /** Offset of the line start within the block text. */
  start: number;
  text: string;
  cells: CellSpan[];
  leadingPipe: boolean;
  trailingPipe: boolean;
};

/** Splits a line into cell spans on unescaped pipes. */
function parseCells(text: string): {
  cells: CellSpan[];
  leadingPipe: boolean;
  trailingPipe: boolean;
} {
  const boundaries: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|" && (index === 0 || text[index - 1] !== "\\")) {
      boundaries.push(index);
    }
  }
  const leadingPipe = text.trimStart().startsWith("|");
  const trailingPipe = text.trimEnd().endsWith("|");
  const cells: CellSpan[] = [];
  let cursor = 0;
  const remaining = [...boundaries];
  if (leadingPipe) {
    cursor = (remaining.shift() ?? 0) + 1;
  }
  for (const boundary of remaining) {
    cells.push({ from: cursor, to: boundary });
    cursor = boundary + 1;
  }
  if (!trailingPipe) {
    cells.push({ from: cursor, to: text.length });
  }
  return { cells, leadingPipe, trailingPipe };
}

/** Parses the block into lines with cell spans. */
export function parseTableLines(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let start = 0;
  for (const lineText of text.split("\n")) {
    lines.push({ start, text: lineText, ...parseCells(lineText) });
    start += lineText.length + 1;
  }
  return lines;
}

const DELIMITER_CELL = /^\s*:?-+:?\s*$/;

/** Whether a line is the GFM header delimiter row. */
export function isDelimiterLine(text: string): boolean {
  const { cells } = parseCells(text);
  return (
    cells.length > 0 &&
    cells.every((cell) => DELIMITER_CELL.test(text.slice(cell.from, cell.to)))
  );
}

function alignmentOf(cellText: string): ColumnAlignment {
  const trimmed = cellText.trim();
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");
  if (left && right) {
    return "center";
  }
  if (left) {
    return "left";
  }
  if (right) {
    return "right";
  }
  return "none";
}

/** The alignment declared per column by the delimiter row. */
export function tableAlignments(text: string): ColumnAlignment[] {
  const lines = parseTableLines(text);
  const delimiter = lines.find((line) => isDelimiterLine(line.text));
  if (delimiter === undefined) {
    return [];
  }
  return delimiter.cells.map((cell) =>
    alignmentOf(delimiter.text.slice(cell.from, cell.to)),
  );
}

function delimiterCellText(alignment: ColumnAlignment, width: number): string {
  const dashes = (count: number): string => "-".repeat(Math.max(1, count));
  switch (alignment) {
    case "center":
      return `:${dashes(width - 2)}:`;
    case "left":
      return `:${dashes(width - 1)}`;
    case "right":
      return `${dashes(width - 1)}:`;
    case "none":
      return dashes(width);
  }
}

/**
 * The formatting pass: pads every cell to its column's display width with
 * single-space gutters, preserving delimiter alignment colons. Returns
 * one declared span per cell whose text changes.
 */
export function formatTableChanges(text: string): TableSpanChange[] {
  const lines = parseTableLines(text);
  const delimiterIndex = lines.findIndex((line) => isDelimiterLine(line.text));
  const widths: number[] = [];
  for (const [index, line] of lines.entries()) {
    for (const [column, cell] of line.cells.entries()) {
      const content = line.text.slice(cell.from, cell.to).trim();
      const width = index === delimiterIndex ? 3 : Math.max(1, content.length);
      widths[column] = Math.max(widths[column] ?? 1, width);
    }
  }
  const changes: TableSpanChange[] = [];
  for (const [index, line] of lines.entries()) {
    for (const [column, cell] of line.cells.entries()) {
      const current = line.text.slice(cell.from, cell.to);
      const width = widths[column] ?? 1;
      const body =
        index === delimiterIndex
          ? delimiterCellText(alignmentOf(current), width)
          : current.trim().padEnd(width);
      const formatted = ` ${body} `;
      if (formatted !== current) {
        changes.push({
          from: line.start + cell.from,
          to: line.start + cell.to,
          insert: formatted,
        });
      }
    }
  }
  return changes;
}

function applySpans(text: string, spans: TableSpanChange[]): string {
  const doc = Text.of(text.split("\n"));
  const set = ChangeSet.of(
    spans.map((span) => ({ ...span })),
    doc.length,
  );
  return set.apply(doc).toString();
}

function structuralSpans(
  text: string,
  operation: TableOperation,
): TableSpanChange[] {
  const lines = parseTableLines(text);
  const delimiterIndex = lines.findIndex((line) => isDelimiterLine(line.text));
  const columnCount = Math.max(...lines.map((line) => line.cells.length), 1);
  if (operation.kind === "insert-row") {
    const template = lines[0];
    const leading = template?.leadingPipe !== false;
    const trailing = template?.trailingPipe !== false;
    const row = `${leading ? "|" : ""}${Array.from({ length: columnCount }, () => "   ").join("|")}${trailing ? "|" : ""}`;
    // A row never lands adjacent to the header on the delimiter's side:
    // above the delimiter becomes above the header's successor, i.e. the
    // first body position, and below the header means below the delimiter.
    let line = Math.max(0, Math.min(operation.line, lines.length - 1));
    let position = operation.position;
    if (delimiterIndex >= 0) {
      if (line < delimiterIndex) {
        line = delimiterIndex;
        position = "below";
      } else if (line === delimiterIndex) {
        position = "below";
      }
    }
    const target = lines[line];
    if (target === undefined) {
      return [];
    }
    if (position === "above") {
      return [{ from: target.start, to: target.start, insert: `${row}\n` }];
    }
    const lineEnd = target.start + target.text.length;
    return [{ from: lineEnd, to: lineEnd, insert: `\n${row}` }];
  }
  const column = Math.max(0, Math.min(operation.column, columnCount - 1));
  const spans: TableSpanChange[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.cells.length === 0) {
      continue;
    }
    const content = index === delimiterIndex ? " --- " : "   ";
    const cell = line.cells[Math.min(column, line.cells.length - 1)];
    if (cell === undefined) {
      continue;
    }
    if (operation.position === "before") {
      spans.push({
        from: line.start + cell.from,
        to: line.start + cell.from,
        insert: `${content}|`,
      });
    } else {
      spans.push({
        from: line.start + cell.to,
        to: line.start + cell.to,
        insert: `|${content}`,
      });
    }
  }
  return spans;
}

/**
 * Builds the full declared change set for one table operation: the
 * structural spans composed with the formatting pass over the structural
 * result, expressed as spans over the original block text.
 */
export function editTable(
  text: string,
  operation: TableOperation,
): TableSpanChange[] {
  const structural = structuralSpans(text, operation);
  if (structural.length === 0) {
    return [];
  }
  const doc = Text.of(text.split("\n"));
  const structuralSet = ChangeSet.of(
    structural.map((span) => ({ ...span })),
    doc.length,
  );
  const afterStructural = structuralSet.apply(doc);
  const formatSet = ChangeSet.of(
    formatTableChanges(afterStructural.toString()).map((span) => ({
      ...span,
    })),
    afterStructural.length,
  );
  const composed = structuralSet.compose(formatSet);
  const spans: TableSpanChange[] = [];
  composed.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    spans.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return spans;
}

/** Applies an operation, returning the resulting block text (for tests). */
export function applyTableOperation(
  text: string,
  operation: TableOperation,
): string {
  return applySpans(text, editTable(text, operation));
}

/** One navigable cell: trimmed content bounds and its grid coordinates. */
export type TableCell = {
  from: number;
  to: number;
  line: number;
  column: number;
};

/**
 * The navigable cells of the block (header and body, never the delimiter
 * row), in traversal order, with offsets of the trimmed cell content.
 */
export function tableCellRanges(text: string): TableCell[] {
  const lines = parseTableLines(text);
  const cells: TableCell[] = [];
  for (const [index, line] of lines.entries()) {
    if (isDelimiterLine(line.text) || line.cells.length === 0) {
      continue;
    }
    for (const [column, cell] of line.cells.entries()) {
      const raw = line.text.slice(cell.from, cell.to);
      const leading = raw.length - raw.trimStart().length;
      const trimmedLength = raw.trim().length;
      const from = line.start + cell.from + leading;
      cells.push({
        from,
        to: from + trimmedLength,
        line: index,
        column,
      });
    }
  }
  return cells;
}
