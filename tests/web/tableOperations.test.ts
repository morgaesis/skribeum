// Criterion 2 (M3a): every table operation declares its byte ranges and
// the M1b containment property holds over them, including the formatting
// pass that re-pads cells the operation did not target. The property is
// asserted byte-for-byte: the declared spans, converted to UTF-8 byte
// ranges, are applied to the base bytes through the same change-set
// applier the save path uses, and must reproduce the operation's result
// exactly. Any touched byte outside a declared range would break the
// reconstruction.

import { describe, expect, it } from "vitest";
import {
  applyByteChangeSet,
  type ByteChange,
} from "../../src/lib/editor/byteChangeSet";
import {
  applyTableOperation,
  editTable,
  formatTableChanges,
  isDelimiterLine,
  type TableOperation,
  tableAlignments,
  tableCellRanges,
} from "../../src/lib/features/tableOperations";

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

  it("clamps a row above the header to the first body position", () => {
    const result = assertContainment(SIMPLE, {
      kind: "insert-row",
      line: 0,
      position: "above",
    });
    const lines = result.split("\n");
    expect(lines[0]).toContain("a");
    expect(isDelimiterLine(lines[1] ?? "")).toBe(true);
    expect(lines[2]?.trim().replaceAll("|", "").trim()).toBe("");
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
    // Inserting a column after column 0 re-pads nothing, but a new widest
    // cell forces re-padding: build a table whose new column makes the
    // format pass touch every line, then rely on assertContainment to
    // prove those touches are declared.
    const uneven = "| a | b |\n| --- | --- |\n| longer-content | d |";
    const spans = editTable(uneven, {
      kind: "insert-column",
      column: 0,
      position: "after",
    });
    // The formatting pass must have emitted declared spans on lines other
    // than the structural insertion points (re-padded cells).
    expect(spans.length).toBeGreaterThan(3);
    assertContainment(uneven, {
      kind: "insert-column",
      column: 0,
      position: "after",
    });
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
        if (operation.kind === "insert-row") {
          // Row inserts never touch the delimiter row.
          expect(after).toEqual(before);
        } else {
          // Column inserts preserve every pre-existing alignment.
          expect(after.length).toBe(before.length + 1);
          const inserted =
            operation.position === "before"
              ? operation.column
              : Math.min(operation.column, before.length - 1) + 1;
          const surviving = [...after];
          surviving.splice(inserted, 1);
          expect(surviving).toEqual(before);
        }
      }
    }
  });
});
