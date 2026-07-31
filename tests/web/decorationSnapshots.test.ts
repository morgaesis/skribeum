// Criterion 1 (M2): decoration snapshot tests. For every corpus file the
// engine computes the full-document decoration set with no selection (so
// no cursor reveal fires) and serializes it as stable text, one
// decoration per line: `from..to kind attrs`. The result is compared
// against a committed golden under tests/web/decoration-snapshots/, so a
// rendering change is a reviewed diff, never a screenshot judgment.
// Regenerate with UPDATE_DECORATION_SNAPSHOTS=1 after an intentional
// change and review the diff.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  computeDecorations,
  serializeDecorationSet,
} from "../../src/lib/editor/decorations/engine";
import { DECORATION_TABLE } from "../../src/lib/editor/decorations/table";
import { bufferFromBytes } from "../../src/lib/editor/lineEndingMap";
import { skribeumMarkdownParser } from "../../src/lib/editor/markdown/obsidian";
import { mathMarkdownExtension } from "../../src/lib/rendering/math";

const renderingParser = skribeumMarkdownParser.configure(mathMarkdownExtension);

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const corpusDirectory = path.join(testDirectory, "..", "corpus");
const snapshotDirectory = path.join(testDirectory, "decoration-snapshots");
const update = process.env.UPDATE_DECORATION_SNAPSHOTS === "1";
const renderingFixtures = [
  {
    name: "mermaid-rendering.md",
    text: "```mermaid\ngraph TD\n  A --> B\n```\n",
  },
] as const;

const decoder = new TextDecoder("utf-8", { fatal: false });

const corpusFiles = readdirSync(corpusDirectory)
  .filter((name) => name.endsWith(".md"))
  .sort();

/** The buffer projection the editor shows: BOM stripped, `\n` separators. */
function projectedText(bytes: Uint8Array): string {
  const bomLength =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? 3
      : 0;
  return decoder.decode(bufferFromBytes(bytes.subarray(bomLength)));
}

function serializedDecorations(text: string): string {
  const tree = renderingParser.parse(text);
  const doc = Text.of(text.split("\n"));
  return serializeDecorationSet(
    computeDecorations({ doc, tree, table: DECORATION_TABLE }),
  );
}

describe("decoration snapshots over the corpus", () => {
  expect(corpusFiles.length).toBeGreaterThan(0);

  it.each(corpusFiles)("%s matches its golden", { timeout: 60000 }, (name) => {
    const text = projectedText(readFileSync(path.join(corpusDirectory, name)));
    const serialized = serializedDecorations(text);
    const goldenPath = path.join(snapshotDirectory, `${name}.decorations.txt`);
    if (update) {
      mkdirSync(snapshotDirectory, { recursive: true });
      writeFileSync(goldenPath, serialized);
      return;
    }
    expect(
      existsSync(goldenPath),
      `missing golden ${goldenPath}; run with UPDATE_DECORATION_SNAPSHOTS=1 and review the diff`,
    ).toBe(true);
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });

  it.each(renderingFixtures)(
    "$name matches its rendering golden",
    ({ name, text }) => {
      const serialized = serializedDecorations(text);
      const goldenPath = path.join(
        snapshotDirectory,
        `${name}.decorations.txt`,
      );
      if (update) {
        mkdirSync(snapshotDirectory, { recursive: true });
        writeFileSync(goldenPath, serialized);
        return;
      }
      expect(
        existsSync(goldenPath),
        `missing golden ${goldenPath}; run with UPDATE_DECORATION_SNAPSHOTS=1 and review the diff`,
      ).toBe(true);
      expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
    },
  );

  it("serialization is deterministic across runs", () => {
    const text = projectedText(
      readFileSync(path.join(corpusDirectory, "callouts.md")),
    );
    expect(serializedDecorations(text)).toBe(serializedDecorations(text));
  });
});
