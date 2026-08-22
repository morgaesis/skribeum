// Criterion 2 (M3a): every table operation declares its byte ranges and
// the M1b containment property holds over them without reformatting cells
// the operation did not target. The property is
// asserted byte-for-byte: the declared spans, converted to UTF-8 byte
// ranges, are applied to the base bytes through the same change-set
// applier the save path uses, and must reproduce the operation's result
// exactly. Any touched byte outside a declared range would break the
// reconstruction.

import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  applyByteChangeSet,
  type ByteChange,
} from "../../src/lib/editor/byteChangeSet";
import {
  applyTableOperation,
  editTable,
  editTableCell,
  extendedTableDocumentEnd,
  formatTableChanges,
  isDelimiterLine,
  type TableOperation,
  tableAlignments,
  tableCellRanges,
} from "../../src/lib/features/tableOperations";
import { TABLE_EDITING_NOTE_CONTENT } from "../e2e/scratchVault";

const encoder = new TextEncoder();

function charToByte(text: string, offset: number): number {
  return encoder.encode(text.slice(0, offset)).length;
}

/** Declared spans lifted to UTF-8 byte space over the base text. */
function declaredByteChanges(
  base: string,
  spans: readonly { from: number; to: number; insert: string }[],
): ByteChange[] {
  return spans.map((span) => ({
    start: charToByte(base, span.from),
    end: charToByte(base, span.to),
    bytes: encoder.encode(span.insert),
  }));
}

/**
 * The containment assertion: the operation's declared ranges, and nothing
 * else, turn the base bytes into the result bytes.
 */
function assertContainment(base: string, operation: TableOperation): string {
  const spans = editTable(base, operation);
  // Declared spans are sorted and non-overlapping (the applier throws
  // otherwise, which is part of the assertion).
  const result = applyTableOperation(base, operation);
  const reconstructed = applyByteChangeSet(
    encoder.encode(base),
    declaredByteChanges(base, spans),
  );
  expect(Array.from(reconstructed)).toEqual(Array.from(encoder.encode(result)));
  return result;
}

const ALL_OPERATIONS: readonly TableOperation[] = [
  { kind: "insert-row", line: 2, position: "below" },
  { kind: "insert-row", line: 2, position: "above" },
  { kind: "insert-row", line: 0, position: "above" },
  { kind: "insert-column", column: 0, position: "before" },
  { kind: "insert-column", column: 0, position: "after" },
  { kind: "insert-column", column: 1, position: "after" },
  { kind: "delete-row", line: 2 },
  { kind: "delete-column", column: 0 },
  { kind: "delete-column", column: 1 },
];

const SIMPLE = "| a | b |\n| --- | --- |\n| c | d |";

describe("table structure operations", () => {
  it("inserts a row below with the delimiter and alignment intact", () => {
    const result = assertContainment(SIMPLE, {
      kind: "insert-row",
      line: 2,
      position: "below",
    });
    const lines = result.split("\n");
    expect(lines).toHaveLength(4);
    expect(isDelimiterLine(lines[1] ?? "")).toBe(true);
    expect(tableAlignments(result)).toEqual(tableAlignments(SIMPLE));
  });

  it("inserts above the header while preserving delimiter adjacency", () => {
    const result = assertContainment(SIMPLE, {
      kind: "insert-row",
      line: 0,
      position: "above",
    });
    const lines = result.split("\n");
    expect(lines[0]?.trim().replaceAll("|", "").trim()).toBe("");
    expect(isDelimiterLine(lines[1] ?? "")).toBe(true);
    expect(lines[2]).toContain("a");
  });

  it("inserts a column preserving GFM alignment markers", () => {
    const aligned = "| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |";
    const result = assertContainment(aligned, {
      kind: "insert-column",
      column: 1,
      position: "after",
    });
    expect(tableAlignments(result)).toEqual([
      "left",
      "center",
      "none",
      "right",
    ]);
    // Existing cell content survives.
    for (const content of ["l", "c", "r", "1", "2", "3"]) {
      expect(result).toContain(` ${content} `);
    }
  });

  it("declares the formatting pass over cells the operation widens", () => {
    const uneven = "| a | b |\n| --- | --- |\n| longer-content | d |";
    const spans = editTable(uneven, {
      kind: "insert-column",
      column: 0,
      position: "after",
    });
    expect(spans).toHaveLength(3);
    const result = assertContainment(uneven, {
      kind: "insert-column",
      column: 0,
      position: "after",
    });
    expect(result).toBe(
      "| a | | b |\n| --- | --- | --- |\n| longer-content | | d |",
    );
  });

  it("normalizes ragged cell widths as declared formatting changes", () => {
    const ragged = "| a | bee |\n| --- | --- |\n| ceee | d |";
    const changes = formatTableChanges(ragged);
    expect(changes.length).toBeGreaterThan(0);
    assertContainment(ragged, {
      kind: "insert-row",
      line: 2,
      position: "below",
    });
  });
});

describe("table cell navigation model", () => {
  it("orders cells by row skipping the delimiter line", () => {
    const cells = tableCellRanges(SIMPLE);
    expect(cells.map((cell) => `${cell.line}:${cell.column}`)).toEqual([
      "0:0",
      "0:1",
      "2:0",
      "2:1",
    ]);
    expect(cells.map((cell) => SIMPLE.slice(cell.from, cell.to))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("writes only one trimmed cell span and escapes a typed pipe", () => {
    const source = "|  alpha   | beta |\n| --- | ---: |\n| café  |  keep  |";
    const change = editTableCell(source, 1, 0, "naïve|🙂");
    expect(change).not.toBeNull();
    if (change === null) {
      return;
    }
    expect(source.slice(change.from, change.to)).toBe("café");
    const result = `${source.slice(0, change.from)}${change.insert}${source.slice(change.to)}`;
    expect(result).toBe(
      "|  alpha   | beta |\n| --- | ---: |\n| naïve\\|🙂  |  keep  |",
    );
    expect(source.slice(0, change.from)).toBe(result.slice(0, change.from));
    const reconstructed = applyByteChangeSet(
      encoder.encode(source),
      declaredByteChanges(source, [change]),
    );
    expect(Array.from(reconstructed)).toEqual(
      Array.from(encoder.encode(result)),
    );
  });

  it("deletes rows and columns without rewriting surviving cell bytes", () => {
    expect(
      applyTableOperation("| a  | b |\n| --- | --- |\n| c | d  |", {
        kind: "delete-row",
        line: 2,
      }),
    ).toBe("| a  | b |\n| --- | --- |");
    expect(
      applyTableOperation("| a  | b |\n| --- | --- |\n| c | d  |", {
        kind: "delete-column",
        column: 0,
      }),
    ).toBe("| b |\n| --- |\n| d  |");
  });

  it("promotes the first body row when deleting the header", () => {
    expect(applyTableOperation(SIMPLE, { kind: "delete-row", line: 0 })).toBe(
      "| c | d |\n| --- | --- |",
    );
    expect(
      applyTableOperation("| a | b |\n| --- | --- |", {
        kind: "delete-row",
        line: 0,
      }),
    ).toBe("");
  });

  it("handles escaped terminal pipes and ragged implicit cells", () => {
    const outerPipeFree = "a | b\\|\n--- | ---\nc | d";
    expect(
      tableCellRanges(outerPipeFree).map((cell) =>
        outerPipeFree.slice(cell.from, cell.to),
      ),
    ).toEqual(["a", "b\\|", "c", "d"]);

    const ragged = "| a | b | c |\n| --- | --- | --- |\n| x | y |";
    expect(
      applyTableOperation(ragged, {
        kind: "insert-column",
        column: 2,
        position: "before",
      }),
    ).toBe("| a | b | | c |\n| --- | --- | --- | --- |\n| x | y | |");
    expect(
      applyTableOperation(ragged, { kind: "delete-column", column: 2 }),
    ).toBe("| a | b |\n| --- | --- |\n| x | y |");

    const oneCellBody = "| a | b | c |\n| --- | --- | --- |\n| x |";
    expect(
      applyTableOperation(oneCellBody, {
        kind: "insert-column",
        column: 2,
        position: "after",
      }),
    ).toBe("| a | b | c | |\n| --- | --- | --- | --- |\n| x | | | |");
    expect(
      applyTableOperation(oneCellBody, {
        kind: "delete-column",
        column: 0,
      }),
    ).toBe("| b | c |\n| --- | --- |\n| |");
  });

  it("treats only the structural second row as the delimiter", () => {
    const source =
      "| --- | --- |\n| --- | --- |\n| --- | --- |\n| value | keep |";
    const cells = tableCellRanges(source);
    expect(cells.map((cell) => source.slice(cell.from, cell.to))).toEqual([
      "---",
      "---",
      "---",
      "---",
      "value",
      "keep",
    ]);
    expect(editTableCell(source, 1, 0, "changed")).toMatchObject({
      insert: "changed",
    });
  });

  it("preserves a terminal newline across structure operations", () => {
    const source = `${SIMPLE}\n`;
    expect(
      applyTableOperation(source, {
        kind: "insert-column",
        column: 0,
        position: "after",
      }),
    ).toBe("| a | | b |\n| --- | --- | --- |\n| c | | d |\n");
    expect(applyTableOperation(source, { kind: "delete-row", line: 2 })).toBe(
      "| a | b |\n| --- | --- |\n",
    );
  });

  it("inserts content between an empty cell's existing gutters", () => {
    const source = "|  | b |\n| --- | --- |\n| c | d |";
    const change = editTableCell(source, 0, 0, "x");
    expect(change).not.toBeNull();
    if (change === null) {
      return;
    }
    expect(
      `${source.slice(0, change.from)}${change.insert}${source.slice(change.to)}`,
    ).toBe("| x | b |\n| --- | --- |\n| c | d |");
  });

  it("handles escaped pipes inside cells", () => {
    const escaped = "| a\\|x | b |\n| --- | --- |\n| c | d |";
    const cells = tableCellRanges(escaped);
    expect(cells.map((cell) => escaped.slice(cell.from, cell.to))).toEqual([
      "a\\|x",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("table block end over a partial row", () => {
  const table = [
    "| Name  | Score |",
    "| :--- | ---: |",
    "| café   | keep  |",
    "| Ada | 10 |",
  ].join("\n");
  const document = Text.of(
    [
      "# Table cell editing",
      "",
      "Before editable table.",
      "",
      ...table.split("\n"),
      "",
      "Large table follows.",
      "",
    ]
      .join("\n")
      .split("\n"),
  );
  const tableFrom = document.toString().indexOf("| Name");
  // A table block spans whole rows. A reported end that stops inside a
  // row must still resolve to that row's end, because every offset a
  // table edit declares is measured against the block text.
  const partialRowEnd = tableFrom + 46;

  it("completes a row the reported end stops inside", () => {
    expect(document.sliceString(partialRowEnd - 3, partialRowEnd)).toBe("| k");
    expect(extendedTableDocumentEnd(document, tableFrom, partialRowEnd)).toBe(
      tableFrom + table.length,
    );
  });

  it("never splices a structure edit into the middle of a row", () => {
    const block = document.sliceString(
      tableFrom,
      extendedTableDocumentEnd(document, tableFrom, partialRowEnd),
    );
    const spans = editTable(block, {
      kind: "insert-row",
      line: 2,
      position: "below",
    });
    const source = document.toString();
    const edited = spans.reduce(
      (text, span) =>
        text.slice(0, tableFrom + span.from) +
        span.insert +
        text.slice(tableFrom + span.to),
      source,
    );
    expect(edited).toBe(
      source.replace("| café   | keep  |\n", "| café   | keep  |\n| | |\n"),
    );
  });

  it("leaves a row-aligned reported end unchanged", () => {
    for (const rows of [1, 2, 3, 4]) {
      const end =
        tableFrom + table.split("\n").slice(0, rows).join("\n").length;
      expect(extendedTableDocumentEnd(document, tableFrom, end)).toBe(
        tableFrom + table.length,
      );
    }
  });

  it("completes only partial rows, never a following paragraph", () => {
    const prose = Text.of(
      ["| a | b |", "| --- | --- |", "| c | d |", "", "Following prose."]
        .join("\n")
        .split("\n"),
    );
    const blockEnd = prose.toString().indexOf("\n\nFollowing");
    // An end inside the paragraph is not a partial row, so it stays put
    // rather than growing the block over prose.
    expect(extendedTableDocumentEnd(prose, 0, blockEnd + 4)).toBe(blockEnd + 4);
  });

  it("completes a partial row in a table without outer pipes", () => {
    const source = "a | b\n--- | ---\nc | d";
    const pipeFree = Text.of(source.split("\n"));
    expect(
      extendedTableDocumentEnd(pipeFree, 0, source.indexOf("c |") + 1),
    ).toBe(source.length);
  });

  it("leaves a prose line that happens to contain a pipe outside the block", () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |\n\nPipe | in prose.";
    const withPipe = Text.of(source.split("\n"));
    const tableEnd = source.indexOf("\n\nPipe");
    // The prose line carries a pipe and the block's column count, but not
    // the header's outer pipes, so it is not a row of this block.
    for (let end = tableEnd + 2; end <= source.length; end += 1) {
      expect(extendedTableDocumentEnd(withPipe, 0, end)).toBeLessThanOrEqual(
        end,
      );
    }
  });

  it("completes the last row when the table ends the document", () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |";
    const trailing = Text.of(source.split("\n"));
    for (let end = 1; end <= source.length; end += 1) {
      expect(extendedTableDocumentEnd(trailing, 0, end)).toBe(source.length);
    }
  });

  it("excludes a paragraph the tree folded into the table with no blank line between", () => {
    // A table's row grammar does not require a pipe on a continuation
    // line, so with no blank line before the next paragraph the parsed
    // tree folds that whole paragraph into the table as its own reported
    // end. The block's real end still has to land after the last genuine
    // row, or the paragraph stays pinned to source and the table can never
    // mount as an interactive grid.
    const source = "| a | b |\n| --- | --- |\n| c | d |\nAfter the table.";
    const doc = Text.of(source.split("\n"));
    const tableEnd = source.indexOf("\nAfter");
    expect(extendedTableDocumentEnd(doc, 0, source.length)).toBe(tableEnd);
  });

  it("keeps a ragged row inside the block by its outer pipes, not its cell count", () => {
    // GFM tables allow ragged rows: a row can carry fewer or more cells
    // than the header. Only the header's own outer-pipe convention, not an
    // exact cell count, tells a short or long row from a paragraph the
    // tree folded in beside it.
    const short = "| a | b | c |\n| --- | --- | --- |\n| x |";
    expect(
      extendedTableDocumentEnd(Text.of(short.split("\n")), 0, short.length),
    ).toBe(short.length);

    const overflow =
      "| a | b | c |\n| --- | --- | --- |\n| a | b | c | d | e |";
    expect(
      extendedTableDocumentEnd(
        Text.of(overflow.split("\n")),
        0,
        overflow.length,
      ),
    ).toBe(overflow.length);
  });

  it("never reaches past the first table of the rendered-table fixture", () => {
    // The end-to-end fixture, verbatim: a small table, a paragraph, then a
    // large table. No reported end may resolve into that paragraph, and a
    // reported end inside the table always resolves to the table's end.
    const fixture = Text.of(TABLE_EDITING_NOTE_CONTENT.split("\n"));
    const text = fixture.toString();
    const from = text.indexOf("| Name");
    const trueEnd = from + table.length;
    const proseFrom = text.indexOf("Large table follows.");
    expect(text.slice(trueEnd, proseFrom)).toBe("\n\n");
    for (let end = 0; end <= text.length; end += 1) {
      const resolved = extendedTableDocumentEnd(fixture, from, end);
      // An end anywhere inside the table resolves to the table's end.
      if (end > from && end <= trueEnd) {
        expect(resolved).toBe(trueEnd);
      }
      // The block never reaches into the paragraph unless the reported
      // end was already there.
      if (resolved >= proseFrom) {
        expect(end).toBeGreaterThanOrEqual(proseFrom);
      }
    }
  });
});

/** Deterministic PRNG for the generated-table sweep. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL_CONTENT = [
  "",
  "x",
  "word",
  "two words",
  "é",
  "naïve café",
  "🙂",
  "a\\|b",
  "*em*",
  "longer content here",
];

function generateTable(random: () => number): string {
  const columns = 1 + Math.floor(random() * 4);
  const bodyRows = 1 + Math.floor(random() * 4);
  const alignment = ["---", ":---", "---:", ":---:"];
  const pick = (options: readonly string[]): string =>
    options[Math.floor(random() * options.length)] ?? "";
  const pad = (): string => " ".repeat(Math.floor(random() * 3));
  const row = (): string =>
    `|${Array.from(
      { length: columns },
      () => `${pad()}${pick(CELL_CONTENT)}${pad()}`,
    ).join("|")}|`;
  const delimiter = `|${Array.from(
    { length: columns },
    () => ` ${pick(alignment)} `,
  ).join("|")}|`;
  return [row(), delimiter, ...Array.from({ length: bodyRows }, row)].join(
    "\n",
  );
}

describe("containment property over generated tables (criterion 2)", () => {
  it("holds for every operation over 200 generated tables", () => {
    const random = mulberry32(0x5eed);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const table = generateTable(random);
      const before = tableAlignments(table);
      for (const operation of ALL_OPERATIONS) {
        const result = assertContainment(table, operation);
        const after = tableAlignments(result);
        if (
          operation.kind === "insert-row" ||
          operation.kind === "delete-row"
        ) {
          // Row inserts never touch the delimiter row.
          expect(after).toEqual(before);
        } else if (operation.kind === "insert-column") {
          // Column inserts preserve every pre-existing alignment.
          expect(after.length).toBe(before.length + 1);
          const inserted =
            operation.position === "before"
              ? operation.column
              : Math.min(operation.column, before.length - 1) + 1;
          const surviving = [...after];
          surviving.splice(inserted, 1);
          expect(surviving).toEqual(before);
        } else if (before.length === 1) {
          expect(result).toBe("");
          expect(after).toEqual([]);
        } else {
          const deleted = Math.min(operation.column, before.length - 1);
          const expected = [...before];
          expected.splice(deleted, 1);
          expect(after).toEqual(expected);
        }
      }
    }
  });
});
