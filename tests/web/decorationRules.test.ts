// Criterion 3 (M2): the cursor-reveal table. Every row of the decoration
// table gets a behavioral vitest case here: the row's decoration is
// asserted present with the cursor elsewhere, and its reveal column is
// asserted by placing the cursor inside the construct (hide and widget
// rows disappear under their reveal policy; `never` rows stay). The table
// in docs/decoration-rules.md is asserted identical to the code table row
// for row, so the document cannot drift from the engine.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { describe, expect, it } from "vitest";
import {
  computeDecorations,
  ruleMatches,
  serializeDecorationSet,
} from "../../src/lib/editor/decorations/engine";
import {
  DECORATION_TABLE,
  type DecorationRule,
} from "../../src/lib/editor/decorations/table";
import { skribeumMarkdownParser } from "../../src/lib/editor/markdown/obsidian";
import { mathMarkdownExtension } from "../../src/lib/rendering/math";

const renderingParser = skribeumMarkdownParser.configure(mathMarkdownExtension);

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sample documents that together contain at least one node matching every
 * table row. A row with no matching node in any sample fails its case, so
 * adding a table row forces adding coverage here.
 */
const SAMPLE_DOCUMENTS = [
  "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n",
  "Setext one\n===\n\nSetext two\n---\n",
  "Some *emphasis* and **strong** and ~~struck~~ text.\n",
  'A [link](https://example.com "the title") and an image ![alt](picture.png) inline.\n',
  "A [full][label] reference and a [label] shortcut.\n\n[label]: https://example.com\n",
  "An autolink <https://example.com/direct> and bare https://example.com/bare text.\n",
  "A [[plain-target]] and an aliased [[target|alias]] link.\n",
  "An embed ![[embedded-note]] inline.\n",
  "| Name | Score |\n| :--- | ---: |\n| Ada | 10 |\n",
  "- plain item\n- [ ] open task\n- [x] done task\n",
  "Inline math $a^2 + b^2 = c^2$ here.\n\n$$\nE = mc^2\n$$\n",
  "Inline `code span` here.\n\n```rust\nfn main() {}\n```\n",
  "```mermaid\ngraph TD\n  A --> B\n```\n",
  "paragraph\n\n    indented code line\n",
  "> [!warning] Callout title\n> callout body\n",
  "> plain quoted line\n",
  "A #sample-tag inline.\n",
  "A paragraph anchor. ^block-anchor-1\n",
  "---\ntitle: sample\n---\n\nBody after frontmatter.\n",
];

type Located = {
  text: string;
  doc: Text;
  node: { from: number; to: number };
  lines: string;
};

/** Finds the first node in any sample document matching the rule. */
function locate(rule: DecorationRule): Located | null {
  for (const text of SAMPLE_DOCUMENTS) {
    const tree = renderingParser.parse(text);
    const doc = Text.of(text.split("\n"));
    let found: SyntaxNode | null = null;
    tree.iterate({
      enter(ref) {
        if (found === null && ref.name === rule.node) {
          const node = ref.node;
          if (ruleMatches(rule, node, doc)) {
            found = node;
          }
        }
        return undefined;
      },
    });
    if (found !== null) {
      const node = found as SyntaxNode;
      const lines = serializeDecorationSet(
        computeDecorations({ doc, tree, table: DECORATION_TABLE }),
      );
      const range = { from: node.from, to: node.to };
      if (present(lines, rule, doc, range)) {
        return { text, doc, node: range, lines };
      }
    }
  }
  return null;
}

function serializedAt(text: string, cursor: number | null): string {
  const tree = renderingParser.parse(text);
  const doc = Text.of(text.split("\n"));
  return serializeDecorationSet(
    computeDecorations({
      doc,
      tree,
      table: DECORATION_TABLE,
      selection: cursor === null ? [] : [{ from: cursor, to: cursor }],
    }),
  );
}

/** Whether the serialized set carries the rule's decoration for the node. */
function present(
  serialized: string,
  rule: DecorationRule,
  doc: Text,
  node: { from: number; to: number },
): boolean {
  const presentation = rule.presentation;
  for (const line of serialized.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const match = /^(\d+)\.\.(\d+) (.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const from = Number(match[1]);
    const to = Number(match[2]);
    const rest = match[3] ?? "";
    switch (presentation.present) {
      case "mark":
        if (
          from === node.from &&
          to === node.to &&
          rest.startsWith(`mark class=${JSON.stringify(presentation.class)}`)
        ) {
          return true;
        }
        break;
      case "hide":
        if (
          rest === `hide node=${rule.node}` &&
          from <= node.from &&
          to >= node.to
        ) {
          return true;
        }
        break;
      case "widget":
        if (
          from === node.from &&
          to === (presentation.place === "before" ? node.from : node.to) &&
          rest.startsWith(`widget ${presentation.widget}`)
        ) {
          return true;
        }
        break;
      case "line": {
        const lineFrom = doc.lineAt(node.from).from;
        if (
          from === lineFrom &&
          to === lineFrom &&
          rest.startsWith("line class=") &&
          rest.includes(presentation.class)
        ) {
          return true;
        }
        break;
      }
    }
  }
  return false;
}

function ruleName(rule: DecorationRule, index: number): string {
  const qualifier =
    rule.parent?.join("|") ??
    rule.notParent?.map((name) => `!${name}`).join("|") ??
    rule.withSibling ??
    rule.withoutSibling ??
    rule.ancestor ??
    "";
  return `${index}: ${rule.node}${qualifier === "" ? "" : ` (${qualifier})`} reveal=${rule.reveal}`;
}

describe("cursor-reveal behavior per table row", () => {
  it.each(
    DECORATION_TABLE.map(
      (rule, index) => [ruleName(rule, index), rule] as const,
    ),
  )("%s", (_name, rule) => {
    const located = locate(rule);
    expect(
      located,
      `no sample document contains a node matching this row; extend SAMPLE_DOCUMENTS`,
    ).not.toBeNull();
    if (located === null) {
      return;
    }
    const away = serializedAt(located.text, null);
    expect(
      present(away, rule, located.doc, located.node),
      `decoration missing with no selection:\n${away}`,
    ).toBe(true);

    const cursor =
      rule.reveal === "never" ? located.text.length : located.node.from;
    const at = serializedAt(located.text, cursor);
    const stillThere = present(at, rule, located.doc, located.node);
    if (rule.reveal === "never" || rule.revealDescendants === true) {
      expect(stillThere, `owning decoration vanished:\n${at}`).toBe(true);
    } else {
      expect(stillThere, `decoration not revealed at cursor:\n${at}`).toBe(
        false,
      );
    }
  });

  it("cursor on the heading line reveals the marker; the line above does not", () => {
    const text = "# Heading\n\nbody\n";
    const revealedOnLine = serializedAt(text, "# Heading".length);
    expect(revealedOnLine).toContain("reveal node=HeaderMark");
    const hiddenFromBody = serializedAt(text, text.indexOf("body"));
    expect(hiddenFromBody).toContain("hide node=HeaderMark");
  });

  it("cursor inside emphasis reveals only that construct's markers", () => {
    const text = "*first* and *second*\n";
    const at = serializedAt(text, 2);
    // The first emphasis is revealed, the second still hides its marks.
    expect(at).toContain("12..13 hide node=EmphasisMark");
    expect(at).not.toContain("0..1 hide node=EmphasisMark");
  });

  it("selects one reveal region when a link is nested in a callout", () => {
    const text =
      "[outside](outside-target)\n\n> [!note] Linked note\n> [inside](inside-target)\n";
    const outsideUrl = text.indexOf("outside-target");
    const insideUrl = text.indexOf("inside-target");
    const hiddenUrlRanges = (serialized: string) =>
      serialized
        .split("\n")
        .filter((line) => line.endsWith("hide node=URL"))
        .map((line) => {
          const match = /^(\d+)\.\.(\d+)/u.exec(line);
          return match === null
            ? null
            : { from: Number(match[1]), to: Number(match[2]) };
        })
        .filter(
          (range): range is { from: number; to: number } => range !== null,
        );
    const hides = (ranges: { from: number; to: number }[], offset: number) =>
      ranges.some((range) => range.from <= offset && range.to >= offset);

    const inside = serializedAt(text, text.indexOf("inside"));
    const insideHidden = hiddenUrlRanges(inside);
    expect(hides(insideHidden, outsideUrl)).toBe(true);
    expect(hides(insideHidden, insideUrl)).toBe(false);
    expect(inside).toContain("cm-skr-rich-callout");
    expect(inside).toContain('data-revealed="true"');

    const outside = serializedAt(text, text.indexOf("outside"));
    const outsideHidden = hiddenUrlRanges(outside);
    expect(hides(outsideHidden, outsideUrl)).toBe(false);
    expect(hides(outsideHidden, insideUrl)).toBe(true);
    expect(outside).toContain("cm-skr-rich-callout");
  });
});

describe("docs/decoration-rules.md mirrors the table", () => {
  function contextOf(rule: DecorationRule): string {
    const parts: string[] = [];
    if (rule.parent !== undefined) {
      parts.push(`parent=${rule.parent.join(",")}`);
    }
    if (rule.notParent !== undefined) {
      parts.push(`notParent=${rule.notParent.join(",")}`);
    }
    if (rule.ancestor !== undefined) {
      parts.push(`ancestor=${rule.ancestor}`);
    }
    if (rule.withSibling !== undefined) {
      parts.push(`withSibling=${rule.withSibling}`);
    }
    if (rule.withoutSibling !== undefined) {
      parts.push(`withoutSibling=${rule.withoutSibling}`);
    }
    if (rule.codeInfo !== undefined) {
      parts.push(`codeInfo=${rule.codeInfo}`);
    }
    if (rule.revealScope !== undefined) {
      parts.push(`revealScope=${rule.revealScope}`);
    }
    if (rule.revealDescendants === true) {
      parts.push("revealDescendants");
    }
    return parts.length === 0 ? "-" : parts.join(" ");
  }

  function presentationOf(rule: DecorationRule): string {
    const presentation = rule.presentation;
    switch (presentation.present) {
      case "mark":
      case "line":
        return `${presentation.present} ${presentation.class}`;
      case "hide":
        return "hide";
      case "widget":
        return `widget ${presentation.widget}`;
    }
  }

  it("row for row, in order", () => {
    const documentText = readFileSync(
      path.join(testDirectory, "..", "..", "docs", "decoration-rules.md"),
      "utf8",
    );
    const documentRows = documentText
      .split("\n")
      .filter((line) => /\| (?:cursor-inside|cursor-line|never) \|$/.test(line))
      .map((line) => {
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim().replace(/^`|`$/g, ""));
        return cells.join(" | ");
      });
    const tableRows = DECORATION_TABLE.map(
      (rule) =>
        `${rule.node} | ${contextOf(rule)} | ${presentationOf(rule)} | ${rule.reveal}`,
    );
    expect(documentRows).toEqual(tableRows);
  });
});
