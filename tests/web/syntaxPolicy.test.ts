import { language } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { LONG_LINE_DECORATION_LIMIT } from "../../src/lib/editor/decorations/engine";
import {
  FRONTMATTER_BLOCK_SCAN_LIMIT,
  MAX_INCREMENTAL_PARAGRAPH_LENGTH,
  skribeumMarkdownParser,
} from "../../src/lib/editor/markdown/obsidian";
import {
  editorSyntaxExtensions,
  hasOverlongLine,
} from "../../src/lib/editor/syntaxPolicy";
import { mathMarkdownExtension } from "../../src/lib/rendering/math";

describe("editor syntax policy", () => {
  it("disables every syntax service above the long-line threshold", () => {
    const overLimit = "x".repeat(LONG_LINE_DECORATION_LIMIT + 1);
    expect(hasOverlongLine(overLimit)).toBe(true);

    const state = EditorState.create({
      doc: overLimit,
      extensions: editorSyntaxExtensions(overLimit),
    });
    expect(state.facet(language)).toBeNull();
    expect(editorSyntaxExtensions(overLimit)).toEqual([]);
  });

  it("keeps syntax services at the threshold", () => {
    const atLimit = "x".repeat(LONG_LINE_DECORATION_LIMIT);
    expect(hasOverlongLine(atLimit)).toBe(false);
    expect(editorSyntaxExtensions(atLimit).length).toBeGreaterThan(0);
  });
});

describe("incremental Markdown blocks", () => {
  it("bounds paragraphs that contain no blank-line boundary", () => {
    const line = "plain text that stays in one CommonMark paragraph\n";
    const document = line.repeat(
      Math.ceil((MAX_INCREMENTAL_PARAGRAPH_LENGTH * 3) / line.length),
    );
    const tree = skribeumMarkdownParser.parse(document);
    const paragraphs: number[] = [];
    tree.iterate({
      enter(ref) {
        if (ref.name === "Paragraph") {
          paragraphs.push(ref.to - ref.from);
        }
      },
    });

    expect(paragraphs.length).toBeGreaterThan(1);
    expect(Math.max(...paragraphs)).toBeLessThan(
      MAX_INCREMENTAL_PARAGRAPH_LENGTH + line.length,
    );
  });

  it("leaves ordinary multiline paragraphs intact", () => {
    const tree = skribeumMarkdownParser.parse("first line\nsecond line\n");
    const names: string[] = [];
    tree.iterate({ enter: (ref) => void names.push(ref.name) });
    expect(names.filter((name) => name === "Paragraph")).toHaveLength(1);
  });

  it("bounds unterminated frontmatter lookahead", () => {
    const line = "property: value\n";
    const document = `---\n${line.repeat(
      Math.ceil((FRONTMATTER_BLOCK_SCAN_LIMIT * 2) / line.length),
    )}`;
    const tree = skribeumMarkdownParser.parse(document);
    const nodes: { name: string; length: number }[] = [];
    tree.iterate({
      enter: (ref) =>
        void nodes.push({
          name: ref.name,
          length: ref.to - ref.from,
        }),
    });

    expect(nodes.some((node) => node.name === "Frontmatter")).toBe(false);
    expect(
      Math.max(
        ...nodes
          .filter((node) => node.name === "Paragraph")
          .map((node) => node.length),
      ),
    ).toBeLessThan(FRONTMATTER_BLOCK_SCAN_LIMIT + line.length);
  });

  it("bounds unterminated math-block lookahead", () => {
    const line = "equation text\n";
    const document = `$$\n${line.repeat(3_000)}`;
    const parser = skribeumMarkdownParser.configure(mathMarkdownExtension);
    const blockLengths: number[] = [];
    parser.parse(document).iterate({
      enter(ref) {
        if (ref.name === "BlockMath") {
          blockLengths.push(ref.to - ref.from);
        }
      },
    });

    expect(blockLengths).toHaveLength(1);
    expect(blockLengths[0]).toBeLessThan(17_000);
  });
});
