// Pure GFM table editing over a table block's source text. Every
// operation returns declared spans (`{from, to, insert}` in character
// offsets within the block). Structural changes preserve every existing
// byte outside the inserted or removed boundary, while cell writes replace
// only one cell's trimmed source span. The M1b containment property is
// asserted over exactly these spans.

import { ChangeSet, Text } from "@codemirror/state";

/** One declared change span within the table block text. */
export type TableSpanChange = { from: number; to: number; insert: string };

export type TableOperation =
  | { kind: "insert-row"; line: number; position: "above" | "below" }
  | { kind: "insert-column"; column: number; position: "before" | "after" }
  | { kind: "delete-row"; line: number }
  | { kind: "delete-column"; column: number };

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
  if (text.length === 0) {
    return { cells: [], leadingPipe: false, trailingPipe: false };
  }
  const boundaries: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let backslashes = 0;
    for (
      let before = index - 1;
      before >= 0 && text[before] === "\\";
      before -= 1
    ) {
      backslashes += 1;
    }
    if (text[index] === "|" && backslashes % 2 === 0) {
      boundaries.push(index);
    }
  }
  const trimmedStart = text.length - text.trimStart().length;
  const trimmedEnd = text.trimEnd().length - 1;
  const leadingPipe = boundaries[0] === trimmedStart;
  const trailingPipe = boundaries.at(-1) === trimmedEnd;
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

function tableDelimiterIndex(lines: readonly ParsedLine[]): number {
  return lines.length > 1 && isDelimiterLine(lines[1]?.text ?? "") ? 1 : -1;
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
  const delimiterIndex = tableDelimiterIndex(lines);
  const delimiter = lines[delimiterIndex];
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
  const delimiterIndex = tableDelimiterIndex(lines);
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
  const delimiterIndex = tableDelimiterIndex(lines);
  const columnCount = Math.max(...lines.map((line) => line.cells.length), 1);
  if (operation.kind === "insert-row") {
    const template = lines[0];
    const leading = template?.leadingPipe !== false;
    const trailing = template?.trailingPipe !== false;
    const row = `${leading ? "|" : ""}${Array.from({ length: columnCount }, () => " ").join("|")}${trailing ? "|" : ""}`;
    // A row never lands adjacent to the header on the delimiter's side:
    // above the delimiter becomes above the header's successor, i.e. the
    // first body position, and below the header means below the delimiter.
    let line = Math.max(0, Math.min(operation.line, lines.length - 1));
    let position = operation.position;
    if (delimiterIndex === 1 && line === 0 && position === "above") {
      const delimiter = lines[delimiterIndex];
      const header = lines[0];
      if (delimiter === undefined || header === undefined) {
        return [];
      }
      const following = lines[delimiterIndex + 1];
      return [
        {
          from: header.start,
          to: following?.start ?? text.length,
          insert: `${row}\n${delimiter.text}\n${header.text}${following === undefined ? "" : "\n"}`,
        },
      ];
    }
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
  if (operation.kind === "delete-row") {
    const line = Math.max(0, Math.min(operation.line, lines.length - 1));
    const target = lines[line];
    if (target === undefined || line === delimiterIndex) {
      return [];
    }
    if (line === 0 && delimiterIndex === 1) {
      const firstBody = lines[2];
      if (firstBody === undefined) {
        return [{ from: 0, to: text.length, insert: "" }];
      }
      return [
        {
          from: target.start,
          to: target.start + target.text.length,
          insert: firstBody.text,
        },
        {
          from: firstBody.start - 1,
          to: firstBody.start + firstBody.text.length,
          insert: "",
        },
      ];
    }
    if (lines.length === 1) {
      return [{ from: 0, to: text.length, insert: "" }];
    }
    if (line < lines.length - 1) {
      return [
        {
          from: target.start,
          to: lines[line + 1]?.start ?? target.start + target.text.length,
          insert: "",
        },
      ];
    }
    return [
      {
        from: Math.max(0, target.start - 1),
        to: target.start + target.text.length,
        insert: "",
      },
    ];
  }

  const column = Math.max(0, Math.min(operation.column, columnCount - 1));
  if (operation.kind === "delete-column") {
    if (columnCount === 1) {
      return [{ from: 0, to: text.length, insert: "" }];
    }
    const removals: TableSpanChange[] = [];
    for (const [index, line] of lines.entries()) {
      const cell = line.cells[column];
      if (cell === undefined) {
        continue;
      }
      const next = line.cells[column + 1];
      const previous = line.cells[column - 1];
      if (next !== undefined) {
        removals.push({
          from: line.start + cell.from,
          to: line.start + next.from,
          insert: "",
        });
      } else if (previous !== undefined) {
        removals.push({
          from: line.start + previous.to,
          to: line.start + cell.to,
          insert: "",
        });
      } else {
        removals.push({
          from: line.start + cell.from,
          to: line.start + cell.to,
          insert: index === delimiterIndex ? " --- " : " ",
        });
      }
    }
    return removals;
  }

  const spans: TableSpanChange[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.cells.length === 0) {
      continue;
    }
    const content = index === delimiterIndex ? " --- " : " ";
    const cell = line.cells[column];
    const trailingCell = line.cells.at(-1);
    if (cell === undefined && trailingCell !== undefined) {
      const missing = Math.max(0, column - line.cells.length);
      const additions = Array.from(
        { length: missing + (operation.position === "before" ? 1 : 2) },
        () => content,
      ).join("|");
      spans.push({
        from: line.start + trailingCell.to,
        to: line.start + trailingCell.to,
        insert: `|${additions}`,
      });
      continue;
    }
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
 * Builds the declared change set for one table structure operation without
 * rewriting existing cells or their padding.
 */
export function editTable(
  text: string,
  operation: TableOperation,
): TableSpanChange[] {
  return structuralSpans(text, operation);
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
  /** Navigable row index, excluding the delimiter row. */
  row: number;
  column: number;
};

/**
 * The navigable cells of the block (header and body, never the delimiter
 * row), in traversal order, with offsets of the trimmed cell content.
 */
export function tableCellRanges(text: string): TableCell[] {
  const lines = parseTableLines(text);
  const delimiterIndex = tableDelimiterIndex(lines);
  const cells: TableCell[] = [];
  let row = 0;
  for (const [index, line] of lines.entries()) {
    if (index === delimiterIndex || line.cells.length === 0) {
      continue;
    }
    for (const [column, cell] of line.cells.entries()) {
      const raw = line.text.slice(cell.from, cell.to);
      const trimmedLength = raw.trim().length;
      const leading =
        trimmedLength === 0
          ? Math.ceil(raw.length / 2)
          : raw.length - raw.trimStart().length;
      const from = line.start + cell.from + leading;
      cells.push({
        from,
        to: from + trimmedLength,
        line: index,
        row,
        column,
      });
    }
    row += 1;
  }
  return cells;
}

/**
 * Completes a row the reported end stops inside.
 *
 * A table block spans whole rows, and every offset a table edit declares
 * is measured against the block text. An end that falls inside a row
 * would make that row parse as its own truncated line, so an edit aimed
 * at the row's end would land in the middle of the row's source instead.
 * Only a partial row is completed; an end that falls in a line which is
 * not a table row stays put rather than growing the block over prose.
 */
function completedRowEnd(sourceFromTable: string, end: number): number {
  const bounded = Math.max(0, Math.min(end, sourceFromTable.length));
  if (bounded === 0 || bounded === sourceFromTable.length) {
    return bounded;
  }
  if (sourceFromTable[bounded] === "\n") {
    return bounded;
  }
  const lineStart = sourceFromTable.lastIndexOf("\n", bounded - 1) + 1;
  const lineEnd = sourceFromTable.indexOf("\n", bounded);
  const rowEnd = lineEnd < 0 ? sourceFromTable.length : lineEnd;
  const row = sourceFromTable.slice(lineStart, rowEnd).trim();
  return row.startsWith("|") ? rowEnd : bounded;
}

/** Extends a parsed table through adjacent pipe rows the Markdown tree omits. */
export function extendedTableBlockEnd(
  sourceFromTable: string,
  parsedLength: number,
): number {
  const blockEnd = completedRowEnd(sourceFromTable, parsedLength);
  const columnCount = Math.max(
    1,
    ...tableCellRanges(sourceFromTable.slice(0, blockEnd))
      .filter((cell) => cell.row === 0)
      .map((cell) => cell.column + 1),
  );
  let to = blockEnd;
  let lineStart = blockEnd;
  while (sourceFromTable[lineStart] === "\n") {
    lineStart += 1;
    const lineEnd = sourceFromTable.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? sourceFromTable.length : lineEnd;
    const line = sourceFromTable.slice(lineStart, end);
    const trimmed = line.trim();
    if (
      !trimmed.startsWith("|") ||
      !trimmed.endsWith("|") ||
      (parseTableLines(line)[0]?.cells.length ?? 0) !== columnCount
    ) {
      break;
    }
    to = end;
    lineStart = end;
  }
  return to;
}

/** Extends a parsed table through adjacent compatible rows in a document. */
export function extendedTableDocumentEnd(
  doc: Text,
  tableFrom: number,
  tableTo: number,
): number {
  return (
    tableFrom +
    extendedTableBlockEnd(
      doc.sliceString(tableFrom, doc.length),
      Math.max(0, tableTo - tableFrom),
    )
  );
}

/** Escapes only pipes that are not already Markdown-escaped. */
export function escapeTableCellPipes(text: string): string {
  let escaped = "";
  let backslashes = 0;
  for (const character of text) {
    if (character === "|" && backslashes % 2 === 0) {
      escaped += "\\";
    }
    escaped += character;
    backslashes = character === "\\" ? backslashes + 1 : 0;
  }
  return escaped;
}

/** One byte-faithful cell write, scoped to the cell's trimmed source span. */
export function editTableCell(
  text: string,
  row: number,
  column: number,
  source: string,
): TableSpanChange | null {
  const cell = tableCellRanges(text).find(
    (candidate) => candidate.row === row && candidate.column === column,
  );
  if (cell === undefined) {
    return null;
  }
  return {
    from: cell.from,
    to: cell.to,
    insert: escapeTableCellPipes(source),
  };
}
