// The TypeScript side of the two-parser conformance gate: emits `(kind,
// start_byte, end_byte)` extraction lines from the editor's extended
// Lezer parse in the exact format `tests/syntax-spec.toml` defines, for
// comparison against the committed Rust goldens in
// `tests/conformance/rust/`. Offsets are raw byte offsets into the file:
// the Lezer parse runs over the BOM-stripped, terminator-normalized
// buffer projection, and every endpoint maps back through the same
// line-ending map the save path uses.
//
// Normalization shims (decision 103), each pinned to a spec ruling:
// - a Link whose label starts with `^` is a footnote reference, skipped;
// - a Link containing a wikilink or embed in its text is not a link
//   ("a wikilink inside would-be CommonMark link text prevents the outer
//   link");
// - reference-form links emit only when a matching reference definition
//   exists (Lezer parses the bracket structure without consulting
//   definitions; CommonMark and pulldown-cmark require the definition);
// - GFM bare-URL autolinks are not extracted (spec excludes extended
//   autolinking); only angle-bracket Autolink nodes emit;
// - documents whose leading `---` is never closed parse without the
//   frontmatter extension, per the unterminated-is-not-frontmatter rule;
// - code-indented ranges are widened to column zero of their first line
//   ("the range starts at column zero of that line"); Lezer's CodeBlock
//   node starts after the indentation;
// - an indented block whose nearest preceding unindented line is a
//   footnote definition is that footnote's continuation, not indented
//   code (the spec grammar includes footnotes; Lezer does not parse
//   them). If footnote continuations ever carry other constructs the
//   gate will fail on them and this shim must give way to a real
//   footnote parser extension.

import type { SyntaxNode } from "@lezer/common";
import {
  bufferFromBytes,
  bufferOffsetToByte,
  buildLineEndingMap,
} from "../../src/lib/editor/lineEndingMap";
import {
  skribeumMarkdownParser,
  skribeumMarkdownParserWithoutFrontmatter,
} from "../../src/lib/editor/markdown/obsidian";
import { utf16OffsetToByteOffset } from "../../src/lib/editor/offsets";

const HEADING_NODES = new Set([
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
]);

type Extraction = { kind: string; from: number; to: number };

/** CommonMark reference-label normalization: trim, collapse, case fold. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The labels of every reference definition in the tree. */
function referenceDefinitions(root: SyntaxNode, text: string): Set<string> {
  const labels = new Set<string>();
  const cursor = root.cursor();
  do {
    if (cursor.name === "LinkReference") {
      const label = cursor.node.getChild("LinkLabel");
      if (label !== null) {
        labels.add(normalizeLabel(text.slice(label.from + 1, label.to - 1)));
      }
    }
  } while (cursor.next());
  return labels;
}

function containsWikilinkOrEmbed(link: SyntaxNode): boolean {
  const cursor = link.cursor();
  while (cursor.next() && cursor.from < link.to) {
    if (cursor.name === "Wikilink" || cursor.name === "Embed") {
      return true;
    }
  }
  return false;
}

/**
 * Whether a Link node emits under the spec's link rulings. `text` is the
 * parsed (normalized) document text.
 */
function linkEmits(
  link: SyntaxNode,
  text: string,
  definitions: Set<string>,
): boolean {
  // Footnote references are never links.
  if (text.charAt(link.from + 1) === "^") {
    return false;
  }
  if (containsWikilinkOrEmbed(link)) {
    return false;
  }
  // Inline links carry a URL child; they always emit.
  if (link.getChild("URL") !== null) {
    return true;
  }
  // Reference forms: full references carry a LinkLabel; collapsed
  // references carry an empty `[]` label and shortcut references none,
  // both using the link text as the label. Emit only when the label has
  // a definition, which Lezer itself does not check.
  const label = link.getChild("LinkLabel");
  if (label !== null) {
    const inner = normalizeLabel(text.slice(label.from + 1, label.to - 1));
    if (inner.length > 0) {
      return definitions.has(inner);
    }
  }
  const marks = link.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  if (open === undefined || close === undefined) {
    return false;
  }
  return definitions.has(normalizeLabel(text.slice(open.to, close.from)));
}

const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;

/**
 * Whether the line starting at `lineStart` sits in a footnote
 * definition's indented continuation: walking upward past blank and
 * indented lines, the nearest unindented non-blank line is a footnote
 * definition opener.
 */
function isFootnoteContinuation(text: string, lineStart: number): boolean {
  let position = lineStart;
  while (position > 0) {
    const previousStart = text.lastIndexOf("\n", position - 2) + 1;
    const line = text.slice(previousStart, position - 1);
    // Blank and indented lines are continuation material; keep walking.
    if (line.trim().length === 0 || /^\s/.test(line)) {
      position = previousStart;
      continue;
    }
    return FOOTNOTE_DEFINITION.test(line);
  }
  return false;
}

/** Whether the normalized text opens a terminated frontmatter block. */
export function hasTerminatedFrontmatter(text: string): boolean {
  if (!text.startsWith("---\n")) {
    return false;
  }
  const lines = text.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---" || line === "...") {
      return true;
    }
  }
  return false;
}

/**
 * Emits the conformance extraction lines for one corpus file's raw bytes,
 * in the spec's canonical format: `<kind> <start>..<end>` per line, sorted
 * by start, end, then kind; trailing LF; empty string when nothing
 * extracts. Non-UTF-8 input yields the empty extraction set.
 */
export function emitExtractions(bytes: Uint8Array): string {
  const bomLength =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? 3
      : 0;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      bufferFromBytes(bytes.subarray(bomLength)),
    );
  } catch {
    return "";
  }
  const parser = hasTerminatedFrontmatter(text)
    ? skribeumMarkdownParser
    : skribeumMarkdownParserWithoutFrontmatter;
  const tree = parser.parse(text);
  const root = tree.topNode;
  const definitions = referenceDefinitions(root, text);

  const extractions: Extraction[] = [];
  const push = (kind: string, from: number, to: number) => {
    extractions.push({ kind, from, to });
  };
  tree.iterate({
    enter(ref) {
      if (HEADING_NODES.has(ref.name)) {
        push("heading", ref.from, ref.to);
      } else if (ref.name === "Link") {
        if (linkEmits(ref.node, text, definitions)) {
          push("link", ref.from, ref.to);
        }
      } else if (ref.name === "Autolink") {
        push("autolink", ref.from, ref.to);
      } else if (ref.name === "Wikilink") {
        if (ref.node.parent?.name !== "Embed") {
          push("wikilink", ref.from, ref.to);
        }
      } else if (ref.name === "Embed") {
        push("embed", ref.from, ref.to);
      } else if (ref.name === "HashTag") {
        push("tag", ref.from, ref.to);
      } else if (ref.name === "BlockId") {
        push("block-id", ref.from, ref.to);
      } else if (ref.name === "InlineCode") {
        push("code-span", ref.from, ref.to);
      } else if (ref.name === "FencedCode") {
        push("code-fence", ref.from, ref.to);
      } else if (ref.name === "CodeBlock") {
        // Widen to column zero of the first line, per the spec's
        // code-indented range rule; suppress footnote continuations.
        const lineStart = text.lastIndexOf("\n", ref.from - 1) + 1;
        if (!isFootnoteContinuation(text, lineStart)) {
          push("code-indented", lineStart, ref.to);
        }
      }
      return undefined;
    },
  });

  // Map normalized-text character offsets to raw byte offsets: character
  // to buffer byte (UTF-8 over the normalized projection, BOM ahead of
  // it), then buffer byte to raw byte through the line-ending map.
  const map = buildLineEndingMap(bytes);
  const endpoints = new Map<number, number>();
  const characterOffsets = [
    ...new Set(
      extractions.flatMap((extraction) => [extraction.from, extraction.to]),
    ),
  ].sort((a, b) => a - b);
  for (const characterOffset of characterOffsets) {
    endpoints.set(
      characterOffset,
      bufferOffsetToByte(
        map,
        bomLength + utf16OffsetToByteOffset(text, characterOffset),
      ),
    );
  }

  const lines = extractions
    .map((extraction) => ({
      kind: extraction.kind,
      from: endpoints.get(extraction.from) ?? 0,
      to: endpoints.get(extraction.to) ?? 0,
    }))
    .sort(
      (a, b) =>
        a.from - b.from ||
        a.to - b.to ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    )
    .map(
      (extraction) => `${extraction.kind} ${extraction.from}..${extraction.to}`,
    );
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
