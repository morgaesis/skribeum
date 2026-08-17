// The list-move primitive over its corpus. Every expectation here is built
// from the corpus manifest's hand-written line ranges and a restatement of
// the move rule in this file, never from the module under test: the suite
// says what the bytes must be, then checks what the module produced.
//
// The central claim, asserted for every legal move in every fixture, is
// that the file afterwards is the file before with the moved extent taken
// out of one place and put back in another, and nothing else different at
// all: not a blank line, not an indentation character, not a terminator,
// not the presence or absence of the final newline. Byte identity is
// asserted on the bytes the edit path actually writes, reached through the
// same line-ending mapping the editor uses, so a move that would silently
// restyle a CRLF into an LF fails here rather than on a user's disk.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyByteChangeSet } from "../../src/lib/editor/byteChangeSet";
import {
  type BufferEdit,
  bufferEditsToChangeSet,
  bufferFromBytes,
  buildLineEndingMap,
  type LineEndingMap,
  type Terminator,
} from "../../src/lib/editor/lineEndingMap";
import {
  applyListMove,
  type ListMoveChange,
  listBlocks,
  moveListItem,
} from "../../src/lib/editor/listMove";
import { skribeumMarkdownParser } from "../../src/lib/editor/markdown/obsidian";

const corpusDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "corpus-list-move",
);

type DeclaredList = { line: number; items: [number, number][] };
type DeclaredFile = { name: string; note: string; lists: DeclaredList[] };

const manifest: { files: DeclaredFile[] } = JSON.parse(
  readFileSync(path.join(corpusDirectory, "manifest.json"), "utf8"),
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TERMINATOR_TEXT: Record<Terminator, string> = {
  lf: "\n",
  crlf: "\r\n",
  cr: "\r",
  none: "",
};

/** One corpus file in every form the assertions need. */
type Fixture = {
  name: string;
  bytes: Uint8Array;
  map: LineEndingMap;
  /** The buffer projection: the same content with `\n` separators. */
  text: string;
  /** The content of each line, terminators excluded. */
  lines: string[];
  terminators: Terminator[];
  lists: DeclaredList[];
};

function readFixture(declared: DeclaredFile): Fixture {
  const bytes = new Uint8Array(
    readFileSync(path.join(corpusDirectory, declared.name)),
  );
  const map = buildLineEndingMap(bytes);
  const text = decoder.decode(bufferFromBytes(bytes));
  const terminators = map.lines.map((line) => line.terminator);
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return {
    name: declared.name,
    bytes,
    map,
    text,
    lines,
    terminators,
    lists: declared.lists,
  };
}

const fixtures = manifest.files.map(readFixture);

/** Reassembles lines with the terminators a document carries per line. */
function assemble(
  lines: readonly string[],
  terminators: readonly Terminator[],
): string {
  return lines
    .map(
      (line, index) => `${line}${TERMINATOR_TEXT[terminators[index] ?? "lf"]}`,
    )
    .join("");
}

/** The buffer projection of a line list: every terminator is one `\n`. */
function assembleBuffer(
  lines: readonly string[],
  terminators: readonly Terminator[],
): string {
  return assemble(
    lines,
    terminators.map((terminator) => (terminator === "none" ? "none" : "lf")),
  );
}

/** The index of the line an offset falls on, counted from the text itself. */
function lineIndexOf(text: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      count += 1;
    }
  }
  return count;
}

/** A byte offset for a UTF-16 offset into the buffer text. */
function byteOffset(text: string, offset: number): number {
  return encoder.encode(text.slice(0, offset)).length;
}

/** The line indices `[start, end)` as a list. */
function span(start: number, end: number): number[] {
  return Array.from(
    { length: Math.max(0, end - start) },
    (_, at) => start + at,
  );
}

/**
 * The independent statement of the move rule, over the corpus manifest's
 * declared line ranges: an item's lines travel together with the blank
 * lines that separate it from its next sibling, or, when it has no next
 * sibling, with the ones that separate it from the previous one. Nothing
 * else in the document is touched. The result is the order the document's
 * lines end up in, by their original line numbers.
 */
function movedOrder(
  lineCount: number,
  list: DeclaredList,
  from: number,
  to: number,
): number[] {
  const count = list.items.length;
  const first = list.items[0];
  const final = list.items[count - 1];
  if (first === undefined || final === undefined) {
    throw new Error("a declared list holds no items");
  }
  const parts = list.items.map((range, index) => {
    const previous = list.items[index - 1];
    return {
      body: span(range[0], range[1]),
      gapBefore: previous === undefined ? [] : span(previous[1], range[0]),
    };
  });
  const removed = parts[from];
  if (removed === undefined) {
    throw new Error("no such item");
  }
  let carriedGap: number[];
  if (from < count - 1) {
    const next = parts[from + 1];
    if (next === undefined) {
      throw new Error("no following item");
    }
    carriedGap = next.gapBefore;
    next.gapBefore = removed.gapBefore;
  } else {
    carriedGap = removed.gapBefore;
  }
  parts.splice(from, 1);
  const anchor = parts[to];
  if (anchor === undefined) {
    parts.push({ body: removed.body, gapBefore: carriedGap });
  } else {
    parts.splice(to, 0, { body: removed.body, gapBefore: anchor.gapBefore });
    anchor.gapBefore = carriedGap;
  }
  const region = parts.flatMap((part) => [...part.gapBefore, ...part.body]);
  return [...span(0, first[0]), ...region, ...span(final[1], lineCount)];
}

/**
 * The terminators the moved document must carry. A terminator belongs to
 * the line it ends and travels with it, which is what makes the move a
 * relocation of bytes rather than a rewrite of them. The absence of a final
 * terminator is the exception: it is a property of the file's end, not of
 * any line, so it stays at the end and the lines before it close up.
 */
function movedTerminators(
  terminators: readonly Terminator[],
  order: readonly number[],
): Terminator[] {
  const travelled = order.map((line) => terminators[line] ?? "lf");
  if (terminators[terminators.length - 1] !== "none") {
    return travelled;
  }
  const missing = travelled.indexOf("none");
  if (missing >= 0) {
    travelled.splice(missing, 1);
    travelled.push("none");
  }
  return travelled;
}

/** Converts declared spans into the byte change set the vault would write. */
function writtenBytes(fixture: Fixture, changes: readonly ListMoveChange[]) {
  const edits: BufferEdit[] = changes.map((change) => ({
    start: byteOffset(fixture.text, change.from),
    end: byteOffset(fixture.text, change.to),
    insert: encoder.encode(change.insert),
  }));
  return applyByteChangeSet(
    fixture.bytes,
    bufferEditsToChangeSet(fixture.map, edits),
  );
}

/** The list block a fixture's declared list refers to. */
function blockOf(fixture: Fixture, declared: DeclaredList) {
  const tree = skribeumMarkdownParser.parse(fixture.text);
  const block = listBlocks(fixture.text, tree).find(
    (candidate) => lineIndexOf(fixture.text, candidate.from) === declared.line,
  );
  if (block === undefined) {
    throw new Error(
      `${fixture.name}: no list starting on line ${declared.line}`,
    );
  }
  return { tree, block };
}

/** The first list block that starts after a heading's line. */
function listUnderHeading(text: string, heading: string) {
  const tree = skribeumMarkdownParser.parse(text);
  const line = text.split("\n").indexOf(heading);
  if (line < 0) {
    throw new Error(`no heading ${heading}`);
  }
  const block = listBlocks(text, tree).find(
    (candidate) => lineIndexOf(text, candidate.from) > line,
  );
  if (block === undefined) {
    throw new Error(`no list under ${heading}`);
  }
  return { tree, block };
}

function fixtureNamed(name: string): Fixture {
  const fixture = fixtures.find((entry) => entry.name === name);
  if (fixture === undefined) {
    throw new Error(`no fixture ${name}`);
  }
  return fixture;
}

/** A fixture's declared list, by position in the manifest. */
function declaredList(fixture: Fixture, index: number): DeclaredList {
  const declared = fixture.lists[index];
  if (declared === undefined) {
    throw new Error(`${fixture.name}: no declared list ${index}`);
  }
  return declared;
}

/** Every ordered pair of distinct positions in a list of `count` items. */
function movePairs(count: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let from = 0; from < count; from += 1) {
    for (let to = 0; to < count; to += 1) {
      if (from !== to) {
        pairs.push([from, to]);
      }
    }
  }
  return pairs;
}

describe("list item extents", () => {
  it("cover exactly the lines the corpus declares", () => {
    for (const fixture of fixtures) {
      const tree = skribeumMarkdownParser.parse(fixture.text);
      const blocks = listBlocks(fixture.text, tree);
      expect(
        blocks.map((block) => lineIndexOf(fixture.text, block.from)),
        fixture.name,
      ).toEqual(fixture.lists.map((list) => list.line));
      for (const [index, declared] of fixture.lists.entries()) {
        const block = blocks[index];
        expect(block, fixture.name).toBeDefined();
        expect(
          block?.items.map((item) => [
            lineIndexOf(fixture.text, item.from),
            lineIndexOf(fixture.text, item.to) + 1,
          ]),
          `${fixture.name} list on line ${declared.line}`,
        ).toEqual(declared.items);
      }
    }
  });

  it("start at the line's first character, not at the marker", () => {
    const fixture = fixtures.find(
      (entry) => entry.name === "nested-sublist.md",
    );
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }
    const declared = fixture.lists[1];
    expect(declared).toBeDefined();
    if (declared === undefined) {
      return;
    }
    const { block } = blockOf(fixture, declared);
    const item = block.items[0];
    expect(item?.indent).toBe("  ");
    expect(fixture.text.slice(item?.from ?? 0, item?.to ?? 0)).toBe(
      "  - child one",
    );
  });
});

describe("moving a list item", () => {
  it("changes nothing when the destination is the item's own position", () => {
    for (const fixture of fixtures) {
      for (const declared of fixture.lists) {
        const { tree, block } = blockOf(fixture, declared);
        for (let index = 0; index < block.items.length; index += 1) {
          const changes = moveListItem({
            text: fixture.text,
            tree,
            source: { list: block.from, index },
            destination: { list: block.from, index },
            lineEndings: fixture.map,
          });
          expect(changes, `${fixture.name} ${index}`).toEqual([]);
          expect(applyListMove(fixture.text, changes ?? [])).toBe(fixture.text);
        }
      }
    }
  });

  it("produces the document the corpus predicts, byte for byte", () => {
    let performed = 0;
    let refused = 0;
    for (const fixture of fixtures) {
      for (const declared of fixture.lists) {
        const { tree, block } = blockOf(fixture, declared);
        for (const [from, to] of movePairs(declared.items.length)) {
          const changes = moveListItem({
            text: fixture.text,
            tree,
            source: { list: block.from, index: from },
            destination: { list: block.from, index: to },
            lineEndings: fixture.map,
          });
          const label = `${fixture.name} ${from} -> ${to}`;
          if (changes === null) {
            // Only a file whose terminators differ across the move can
            // refuse; every uniform file must accept every reordering.
            expect(fixture.name, label).toBe("mixed-endings.md");
            refused += 1;
            continue;
          }
          performed += 1;

          // The move is declared as one removal and one insertion, and
          // reinserts exactly as many characters as it removed.
          expect(changes.length, label).toBe(2);
          const removal = changes.find((change) => change.insert === "");
          const addition = changes.find((change) => change.insert !== "");
          expect(removal, label).toBeDefined();
          expect(addition, label).toBeDefined();
          expect(addition?.from, label).toBe(addition?.to);
          expect(addition?.insert.length, label).toBe(
            (removal?.to ?? 0) - (removal?.from ?? 0),
          );

          const order = movedOrder(fixture.lines.length, declared, from, to);
          const expectedLines = order.map((line) => fixture.lines[line] ?? "");
          const expectedTerminators = movedTerminators(
            fixture.terminators,
            order,
          );
          expect(applyListMove(fixture.text, changes), label).toBe(
            assembleBuffer(expectedLines, expectedTerminators),
          );
          expect(decoder.decode(writtenBytes(fixture, changes)), label).toBe(
            assemble(expectedLines, expectedTerminators),
          );
        }
      }
    }
    expect(performed).toBeGreaterThan(40);
    expect(refused).toBeGreaterThan(0);
  });

  it("restores the original bytes when the move is undone", () => {
    for (const fixture of fixtures) {
      for (const declared of fixture.lists) {
        const { tree, block } = blockOf(fixture, declared);
        for (const [from, to] of movePairs(declared.items.length)) {
          const label = `${fixture.name} ${from} -> ${to} -> ${from}`;
          const forward = moveListItem({
            text: fixture.text,
            tree,
            source: { list: block.from, index: from },
            destination: { list: block.from, index: to },
            lineEndings: fixture.map,
          });
          if (forward === null) {
            continue;
          }
          const movedBytes = writtenBytes(fixture, forward);
          const movedMap = buildLineEndingMap(movedBytes);
          const movedText = decoder.decode(bufferFromBytes(movedBytes));
          const movedTree = skribeumMarkdownParser.parse(movedText);
          const movedBlock = listBlocks(movedText, movedTree).find(
            (candidate) =>
              lineIndexOf(movedText, candidate.from) === declared.line,
          );
          expect(movedBlock, label).toBeDefined();
          if (movedBlock === undefined) {
            continue;
          }
          const back = moveListItem({
            text: movedText,
            tree: movedTree,
            source: { list: movedBlock.from, index: to },
            destination: { list: movedBlock.from, index: from },
            lineEndings: movedMap,
          });
          if (back === null) {
            // Only a mixed-ending file can refuse the way home: writing the
            // item back beside a line whose terminator differs from its own
            // would restyle it, so the primitive declines instead.
            expect(fixture.name, label).toBe("mixed-endings.md");
            continue;
          }
          const edits: BufferEdit[] = back.map((change) => ({
            start: byteOffset(movedText, change.from),
            end: byteOffset(movedText, change.to),
            insert: encoder.encode(change.insert),
          }));
          const restored = applyByteChangeSet(
            movedBytes,
            bufferEditsToChangeSet(movedMap, edits),
          );
          expect([...restored], label).toEqual([...fixture.bytes]);
        }
      }
    }
  });
});

describe("moving a list item between lists", () => {
  it("takes the destination's marker and leaves every other item alone", () => {
    const fixture = fixtureNamed("markers-star-plus.md");
    const stars = listUnderHeading(fixture.text, "## Stars");
    const pluses = listUnderHeading(fixture.text, "## Pluses");
    const changes = moveListItem({
      text: fixture.text,
      tree: stars.tree,
      source: { list: stars.block.from, index: 1 },
      destination: { list: pluses.block.from, index: 0 },
      lineEndings: fixture.map,
    });
    expect(changes).not.toBeNull();
    expect(applyListMove(fixture.text, changes ?? [])).toBe(
      [
        "## Stars",
        "* alpha",
        "* gamma",
        "",
        "## Pluses",
        "+ beta",
        "+ delta",
        "+ epsilon",
        "",
      ].join("\n"),
    );
  });

  it("takes a numbered list's delimiter without renumbering anything", () => {
    const fixture = fixtureNamed("ordered.md");
    const dotted = listUnderHeading(fixture.text, "## Numbered");
    const parenthesised = listUnderHeading(fixture.text, "## Parenthesised");
    const changes = moveListItem({
      text: fixture.text,
      tree: dotted.tree,
      source: { list: dotted.block.from, index: 1 },
      destination: { list: parenthesised.block.from, index: 1 },
      lineEndings: fixture.map,
    });
    expect(changes).not.toBeNull();
    expect(applyListMove(fixture.text, changes ?? [])).toBe(
      [
        "## Numbered",
        "1. first",
        "3. third",
        "",
        "## Parenthesised",
        "1) alpha",
        "2) second",
        "2) beta",
        "",
      ].join("\n"),
    );
  });

  it("refuses to turn a bullet into a numbered item", () => {
    const fixture = fixtureNamed("ordered.md");
    const numbered = listUnderHeading(fixture.text, "## Numbered");
    const bullets = fixtureNamed("markers-star-plus.md");
    const source = listUnderHeading(bullets.text, "## Stars");
    // Both lists in one document: a bullet column beside a numbered one.
    const text = `${bullets.text}\n${fixture.text}`;
    const tree = skribeumMarkdownParser.parse(text);
    const blocks = listBlocks(text, tree);
    const bulletBlock = blocks.find((block) => block.kind === "bullet");
    const orderedBlock = blocks.find((block) => block.kind === "ordered");
    expect(bulletBlock).toBeDefined();
    expect(orderedBlock).toBeDefined();
    expect(source.block.kind).toBe("bullet");
    expect(numbered.block.kind).toBe("ordered");
    expect(
      moveListItem({
        text,
        tree,
        source: { list: bulletBlock?.from ?? 0, index: 0 },
        destination: { list: orderedBlock?.from ?? 0, index: 0 },
      }),
    ).toBeNull();
  });

  it("re-indents an item lifted out of a sublist", () => {
    const fixture = fixtureNamed("nested-sublist.md");
    const outer = fixture.lists[0];
    const inner = fixture.lists[1];
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    if (outer === undefined || inner === undefined) {
      return;
    }
    const outerBlock = blockOf(fixture, outer);
    const innerBlock = blockOf(fixture, inner);
    const changes = moveListItem({
      text: fixture.text,
      tree: outerBlock.tree,
      source: { list: innerBlock.block.from, index: 0 },
      destination: { list: outerBlock.block.from, index: 1 },
      lineEndings: fixture.map,
    });
    expect(changes).not.toBeNull();
    expect(applyListMove(fixture.text, changes ?? [])).toBe(
      [
        "## Nested",
        "- parent one",
        "  - child two",
        "- child one",
        "- parent two",
        "- parent three",
        "",
      ].join("\n"),
    );
  });

  it("refuses a re-indentation that would change what a tab expands to", () => {
    const text = "- outer\n  - child one\n  \tcontinued\n- other\n";
    const tree = skribeumMarkdownParser.parse(text);
    const blocks = listBlocks(text, tree);
    const outer = blocks[0];
    const inner = blocks[1];
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(
      moveListItem({
        text,
        tree,
        source: { list: inner?.from ?? 0, index: 0 },
        destination: { list: outer?.from ?? 0, index: 1 },
      }),
    ).toBeNull();
    // The same item without the tab continuation moves without complaint.
    const plain = "- outer\n  - child one\n  continued\n- other\n";
    const plainTree = skribeumMarkdownParser.parse(plain);
    const plainBlocks = listBlocks(plain, plainTree);
    const changes = moveListItem({
      text: plain,
      tree: plainTree,
      source: { list: plainBlocks[1]?.from ?? 0, index: 0 },
      destination: { list: plainBlocks[0]?.from ?? 0, index: 1 },
    });
    expect(changes).not.toBeNull();
    expect(applyListMove(plain, changes ?? [])).toBe(
      "- outer\n- child one\ncontinued\n- other\n",
    );
  });

  it("carries a loose item's blank line into a tight list", () => {
    const fixture = fixtureNamed("loose-and-tight-columns.md");
    const loose = listUnderHeading(fixture.text, "## Loose column");
    const tight = listUnderHeading(fixture.text, "## Tight column");
    const changes = moveListItem({
      text: fixture.text,
      tree: loose.tree,
      source: { list: loose.block.from, index: 0 },
      destination: { list: tight.block.from, index: 0 },
      lineEndings: fixture.map,
    });
    expect(changes).not.toBeNull();
    const moved = applyListMove(fixture.text, changes ?? []);
    expect(moved).toBe(
      [
        "## Loose column",
        "- loose two",
        "",
        "## Tight column",
        "- loose one",
        "",
        "- tight one",
        "- tight two",
        "",
      ].join("\n"),
    );
    // And the move is reversible byte for byte.
    const movedTree = skribeumMarkdownParser.parse(moved);
    const movedBlocks = listBlocks(moved, movedTree);
    const back = moveListItem({
      text: moved,
      tree: movedTree,
      source: { list: movedBlocks[1]?.from ?? 0, index: 0 },
      destination: { list: movedBlocks[0]?.from ?? 0, index: 0 },
    });
    expect(back).not.toBeNull();
    expect(applyListMove(moved, back ?? [])).toBe(fixture.text);
  });

  it("offers no destination under a heading that has no list", () => {
    const fixture = fixtureNamed("empty-items.md");
    const tree = skribeumMarkdownParser.parse(fixture.text);
    const blocks = listBlocks(fixture.text, tree);
    const emptyColumn = fixture.text.indexOf("## Empty column");
    expect(
      blocks.some((block) => block.from > emptyColumn),
      "a heading with no list beneath it is not a list",
    ).toBe(false);
    expect(
      moveListItem({
        text: fixture.text,
        tree,
        source: { list: blocks[0]?.from ?? 0, index: 0 },
        destination: { list: emptyColumn, index: 0 },
      }),
    ).toBeNull();
  });
});

describe("line endings across a move", () => {
  it("refuses a move that would re-emit a CRLF item as LF", () => {
    const fixture = fixtureNamed("mixed-endings.md");
    const declared = declaredList(fixture, 0);
    const { tree, block } = blockOf(fixture, declared);
    // The column's first two items end CRLF and its third ends LF, so the
    // conversion to bytes could only write the moved item's break in one of
    // the two styles. Moving inside the CRLF run is exact; crossing into
    // the LF-terminated item is refused rather than restyled.
    expect(fixture.terminators.slice(3, 6)).toEqual(["crlf", "crlf", "lf"]);
    const inside = moveListItem({
      text: fixture.text,
      tree,
      source: { list: block.from, index: 1 },
      destination: { list: block.from, index: 0 },
      lineEndings: fixture.map,
    });
    expect(inside).not.toBeNull();
    expect(decoder.decode(writtenBytes(fixture, inside ?? []))).toBe(
      "# Mixed endings\n" +
        "\r\n## Column\r\n- second item\r\n- first item\r\n- third item\n" +
        "\n## Other\n- alpha\r- beta\n",
    );
    expect(
      moveListItem({
        text: fixture.text,
        tree,
        source: { list: block.from, index: 2 },
        destination: { list: block.from, index: 0 },
        lineEndings: fixture.map,
      }),
    ).toBeNull();
  });

  it("refuses to append an item beside a differently terminated line", () => {
    // The case byte identity cannot reach. The second column is
    //
    //     "## Other\n- alpha\r- beta\n"
    //
    // Moving `- beta` up is exact: the break written before it takes the
    // style of the line it is written beside, and `## Other` ends LF, which
    // is `- beta`'s own style. The reverse is not reachable. Putting
    // `- beta` back after `- alpha` means writing a break beside a line
    // that ends CR, and the buffer-to-byte conversion emits an insertion's
    // breaks in exactly one style: the style of the line the insertion
    // starts on. The result would be "- alpha\r- beta\r", which is a byte
    // the move was never asked to touch, so the move is refused instead.
    const fixture = fixtureNamed("mixed-endings.md");
    expect(
      decoder.decode(fixture.bytes).endsWith("## Other\n- alpha\r- beta\n"),
    ).toBe(true);
    const declared = declaredList(fixture, 1);
    const { tree, block } = blockOf(fixture, declared);
    expect(fixture.terminators.slice(8, 10)).toEqual(["cr", "lf"]);

    const up = moveListItem({
      text: fixture.text,
      tree,
      source: { list: block.from, index: 1 },
      destination: { list: block.from, index: 0 },
      lineEndings: fixture.map,
    });
    expect(up).not.toBeNull();
    const moved = writtenBytes(fixture, up ?? []);
    expect(decoder.decode(moved).endsWith("## Other\n- beta\n- alpha\r")).toBe(
      true,
    );

    const movedMap = buildLineEndingMap(moved);
    const movedText = decoder.decode(bufferFromBytes(moved));
    const movedTree = skribeumMarkdownParser.parse(movedText);
    const movedBlock = listBlocks(movedText, movedTree).find(
      (candidate) => lineIndexOf(movedText, candidate.from) === declared.line,
    );
    expect(movedBlock).toBeDefined();
    expect(
      moveListItem({
        text: movedText,
        tree: movedTree,
        source: { list: movedBlock?.from ?? 0, index: 0 },
        destination: { list: movedBlock?.from ?? 0, index: 1 },
        lineEndings: movedMap,
      }),
      "a lossy move must be declined, not approximated",
    ).toBeNull();
  });

  it("keeps a terminatorless final line terminatorless", () => {
    const fixture = fixtureNamed("no-trailing-newline.md");
    const declared = declaredList(fixture, 0);
    const { tree, block } = blockOf(fixture, declared);
    const changes = moveListItem({
      text: fixture.text,
      tree,
      source: { list: block.from, index: 2 },
      destination: { list: block.from, index: 0 },
      lineEndings: fixture.map,
    });
    expect(changes).not.toBeNull();
    const written = decoder.decode(writtenBytes(fixture, changes ?? []));
    expect(written).toBe("## Queue\n- third\n- first\n- second");
    expect(written.endsWith("\n")).toBe(false);
    expect(written.length).toBe(fixture.bytes.length);
  });
});
