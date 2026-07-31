// The heading outline model: nesting from the syntax tree, setext
// support, and collapse-aware flattening for the panel.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { obsidianMarkdownExtensions } from "../../src/lib/editor/markdown/obsidian";
import { computeOutline, flattenOutline } from "../../src/lib/features/outline";

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: markdown({
      base: markdownLanguage,
      extensions: obsidianMarkdownExtensions,
    }),
  });
}

const DOCUMENT = [
  "# Top",
  "",
  "intro",
  "",
  "## Section A",
  "",
  "### Detail A1",
  "",
  "## Section B",
  "",
  "Setext",
  "======",
  "",
  "body",
].join("\n");

describe("outline computation", () => {
  it("nests headings by level and records positions", () => {
    const outline = computeOutline(stateOf(DOCUMENT));
    expect(outline.map((entry) => entry.title)).toEqual(["Top", "Setext"]);
    const top = outline[0];
    expect(top?.children.map((entry) => entry.title)).toEqual([
      "Section A",
      "Section B",
    ]);
    expect(top?.children[0]?.children.map((entry) => entry.title)).toEqual([
      "Detail A1",
    ]);
    expect(top?.from).toBe(0);
    expect(DOCUMENT.slice(top?.children[0]?.from)).toMatch(/^## Section A/);
  });

  it("handles skipped levels without losing entries", () => {
    const outline = computeOutline(stateOf("# A\n\n#### Deep\n\n## B\n"));
    expect(outline).toHaveLength(1);
    expect(outline[0]?.children.map((entry) => entry.title)).toEqual([
      "Deep",
      "B",
    ]);
  });

  it("returns an empty outline for a document without headings", () => {
    expect(computeOutline(stateOf("plain text\n\nmore text\n"))).toEqual([]);
  });
});

describe("outline flattening", () => {
  it("flattens in document order with depths", () => {
    const outline = computeOutline(stateOf(DOCUMENT));
    const rows = flattenOutline(outline, new Set());
    expect(rows.map((row) => `${row.depth}:${row.entry.title}`)).toEqual([
      "1:Top",
      "2:Section A",
      "3:Detail A1",
      "2:Section B",
      "1:Setext",
    ]);
  });

  it("omits descendants of collapsed entries", () => {
    const outline = computeOutline(stateOf(DOCUMENT));
    const top = outline[0];
    const collapsed = new Set([top?.from ?? -1]);
    const rows = flattenOutline(outline, collapsed);
    expect(rows.map((row) => row.entry.title)).toEqual(["Top", "Setext"]);
    expect(rows[0]?.hasChildren).toBe(true);
  });
});
