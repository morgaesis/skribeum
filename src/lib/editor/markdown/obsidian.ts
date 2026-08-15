// Obsidian constructs the stock CommonMark+GFM parser lacks: wikilinks,
// embeds, tags, block identifiers and callout marks, added through
// @lezer/markdown MarkdownConfig extensions. These node names are the sole
// vocabulary the decoration table speaks, and the same extended parser
// feeds the two-parser conformance emitter, so this module is the single
// place the webview's Obsidian syntax lives.

import {
  type BlockContext,
  parser as commonmark,
  type Element,
  Emoji,
  GFM,
  type InlineContext,
  type LeafBlock,
  type LeafBlockParser,
  type MarkdownConfig,
  Subscript,
  Superscript,
} from "@lezer/markdown";
import { mathMarkdownExtension } from "../../rendering/math";
import { DEFAULT_TASK_STATUSES, type TaskStatus } from "../../taskStatuses";

const CHAR_EXCLAMATION = 33;
const CHAR_HASH = 35;
const CHAR_BRACKET_OPEN = 91;
const CHAR_BRACKET_CLOSE = 93;
const CHAR_CARET = 94;
const CHAR_PIPE = 124;
const CHAR_NEWLINE = 10;
const TASK_DATE_PAYLOAD = /^📅 \d{4}-\d{2}-\d{2}/u;
const TASK_LEVEL_PAYLOADS = ["⏫", "🔼", "🔽"] as const;

/**
 * Parses a wikilink body starting at `start` (the first `[`). Returns the
 * assembled element or null when no `]]` closes the link on the same line.
 */
function wikilinkElement(cx: InlineContext, start: number): Element | null {
  if (
    cx.char(start) !== CHAR_BRACKET_OPEN ||
    cx.char(start + 1) !== CHAR_BRACKET_OPEN
  ) {
    return null;
  }
  let pipe = -1;
  let close = -1;
  for (let position = start + 2; position < cx.end; position += 1) {
    const code = cx.char(position);
    if (code === CHAR_NEWLINE) {
      return null;
    }
    if (code === CHAR_PIPE && pipe === -1) {
      pipe = position;
    }
    if (
      code === CHAR_BRACKET_CLOSE &&
      cx.char(position + 1) === CHAR_BRACKET_CLOSE
    ) {
      close = position;
      break;
    }
    if (code === CHAR_BRACKET_OPEN) {
      return null;
    }
  }
  if (close === -1 || close === start + 2) {
    return null;
  }
  const children: Element[] = [cx.elt("WikilinkMark", start, start + 2)];
  if (pipe === -1) {
    children.push(cx.elt("WikilinkTarget", start + 2, close));
  } else {
    children.push(
      cx.elt("WikilinkTarget", start + 2, pipe),
      cx.elt("WikilinkMark", pipe, pipe + 1),
      cx.elt("WikilinkAlias", pipe + 1, close),
    );
  }
  children.push(cx.elt("WikilinkMark", close, close + 2));
  return cx.elt("Wikilink", start, close + 2, children);
}

const wikilinks: MarkdownConfig = {
  defineNodes: [
    "Wikilink",
    "WikilinkMark",
    "WikilinkTarget",
    "WikilinkAlias",
    "Embed",
    "EmbedMark",
  ],
  parseInline: [
    {
      name: "Embed",
      before: "Image",
      parse(cx, next, pos) {
        if (next !== CHAR_EXCLAMATION) {
          return -1;
        }
        const link = wikilinkElement(cx, pos + 1);
        if (link === null) {
          return -1;
        }
        return cx.addElement(
          cx.elt("Embed", pos, link.to, [
            cx.elt("EmbedMark", pos, pos + 1),
            link,
          ]),
        );
      },
    },
    {
      name: "Wikilink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== CHAR_BRACKET_OPEN) {
          return -1;
        }
        const link = wikilinkElement(cx, pos);
        return link === null ? -1 : cx.addElement(link);
      },
    },
  ],
};

/**
 * Obsidian tag characters per the syntax specification: Unicode
 * alphanumerics (letters in any script, digits), combining marks so
 * accented sequences survive, underscore, hyphen and the nesting slash.
 */
const TAG_BODY = /^#([\p{L}\p{N}\p{M}_/-]+)/u;
/** A valid tag body contains at least one non-ASCII-digit character. */
const TAG_NON_NUMERIC = /[^0-9]/;
/** Tags never grow past this scan window; longer matches are not tags. */
const TAG_SCAN_LIMIT = 512;

const tags: MarkdownConfig = {
  defineNodes: ["HashTag"],
  parseInline: [
    {
      name: "HashTag",
      parse(cx, next, pos) {
        if (next !== CHAR_HASH) {
          return -1;
        }
        if (pos > cx.offset && !/\s/u.test(cx.slice(pos - 1, pos))) {
          return -1;
        }
        const window = cx.slice(pos, Math.min(cx.end, pos + TAG_SCAN_LIMIT));
        const match = TAG_BODY.exec(window);
        if (match === null || match[1] === undefined) {
          return -1;
        }
        // A tag never ends in '/': trailing slashes fall outside the range.
        let body = match[1];
        while (body.endsWith("/")) {
          body = body.slice(0, -1);
        }
        if (body.length === 0 || !TAG_NON_NUMERIC.test(body)) {
          return -1;
        }
        return cx.addElement(cx.elt("HashTag", pos, pos + 1 + body.length));
      },
    },
  ],
};

/** Block identifiers are short; a longer caret run is never one. */
const BLOCK_ID_SCAN_LIMIT = 128;
/** The identifier body, then only whitespace before the line end. */
const BLOCK_ID_BODY = /^\^([A-Za-z0-9-]+)[ \t]*(\n|$)/;

const blockIds: MarkdownConfig = {
  defineNodes: ["BlockId"],
  parseInline: [
    {
      name: "BlockId",
      parse(cx, next, pos) {
        if (next !== CHAR_CARET) {
          return -1;
        }
        if (pos > cx.offset && !/\s/.test(cx.slice(pos - 1, pos))) {
          return -1;
        }
        const window = cx.slice(
          pos,
          Math.min(cx.end, pos + BLOCK_ID_SCAN_LIMIT),
        );
        const match = BLOCK_ID_BODY.exec(window);
        if (match === null || match[1] === undefined) {
          return -1;
        }
        // A `$` match at the scan-window edge is truncation, not line end.
        if (match[2] !== "\n" && pos + window.length < cx.end) {
          return -1;
        }
        // Trailing whitespace before the terminator stays outside the range.
        return cx.addElement(cx.elt("BlockId", pos, pos + 1 + match[1].length));
      },
    },
  ],
};

/**
 * The callout head `[!type]` with an optional fold marker, recognized only
 * at the very start of a block's inline content. The decoration engine and
 * the conformance emitter both additionally require an enclosing
 * Blockquote before treating the mark as a callout, which the inline
 * parser cannot see from here.
 */
const CALLOUT_HEAD = /^\[!([A-Za-z0-9_-]+)\]([+-])?/;
const CALLOUT_SCAN_LIMIT = 64;

const callouts: MarkdownConfig = {
  defineNodes: ["CalloutMark", "CalloutType"],
  parseInline: [
    {
      name: "CalloutMark",
      before: "Link",
      parse(cx, next, pos) {
        if (
          next !== CHAR_BRACKET_OPEN ||
          pos !== cx.offset ||
          cx.char(pos + 1) !== CHAR_EXCLAMATION
        ) {
          return -1;
        }
        const window = cx.slice(
          pos,
          Math.min(cx.end, pos + CALLOUT_SCAN_LIMIT),
        );
        const match = CALLOUT_HEAD.exec(window);
        if (match === null || match[1] === undefined) {
          return -1;
        }
        return cx.addElement(
          cx.elt("CalloutMark", pos, pos + match[0].length, [
            cx.elt("CalloutType", pos + 2, pos + 2 + match[1].length),
          ]),
        );
      },
    },
  ],
};

/**
 * A footnote label: at least one character, no whitespace and no closing
 * bracket, so `[^1]`, `[^note-2]` and `[^a.b]` are labels while `[^ ]`,
 * `[^]` and a bracket run spanning a line are not.
 */
const FOOTNOTE_REFERENCE = /^\[\^([^\]\s]+)\]/;
/** The definition head `[^label]:` at the start of a leaf block. */
const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:/;
/** A reference never grows past this scan window. */
const FOOTNOTE_SCAN_LIMIT = 256;

class FootnoteDefinitionParser implements LeafBlockParser {
  constructor(
    private readonly headLength: number,
    private readonly labelLength: number,
  ) {}

  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    const labelFrom = leaf.start + 2;
    const labelTo = labelFrom + this.labelLength;
    cx.addLeafElement(
      leaf,
      cx.elt(
        "FootnoteDefinition",
        leaf.start,
        leaf.start + leaf.content.length,
        [
          cx.elt("FootnoteDefinitionMark", leaf.start, labelFrom),
          cx.elt("FootnoteLabel", labelFrom, labelTo),
          cx.elt(
            "FootnoteDefinitionMark",
            labelTo,
            leaf.start + this.headLength,
          ),
          ...cx.parser.parseInline(
            leaf.content.slice(this.headLength),
            leaf.start + this.headLength,
          ),
        ],
      ),
    );
    return true;
  }
}

/**
 * Footnotes, which CommonMark and GFM both leave out: `[^label]` in prose
 * is a reference and a leaf block opening with `[^label]:` is its
 * definition. The reference parser runs before `Link` so the bracket run
 * is claimed as one footnote rather than a link with a caret in it, and
 * the definition parser runs before `LinkReference` so a definition line
 * is never read as a link-reference definition.
 */
const footnotes: MarkdownConfig = {
  defineNodes: [
    "FootnoteReference",
    "FootnoteMark",
    "FootnoteLabel",
    { name: "FootnoteDefinition", block: true },
    "FootnoteDefinitionMark",
  ],
  parseInline: [
    {
      name: "FootnoteReference",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== CHAR_BRACKET_OPEN || cx.char(pos + 1) !== CHAR_CARET) {
          return -1;
        }
        const window = cx.slice(
          pos,
          Math.min(cx.end, pos + FOOTNOTE_SCAN_LIMIT),
        );
        const match = FOOTNOTE_REFERENCE.exec(window);
        if (match === null || match[1] === undefined) {
          return -1;
        }
        const labelFrom = pos + 2;
        const labelTo = labelFrom + match[1].length;
        const end = pos + match[0].length;
        return cx.addElement(
          cx.elt("FootnoteReference", pos, end, [
            cx.elt("FootnoteMark", pos, labelFrom),
            cx.elt("FootnoteLabel", labelFrom, labelTo),
            cx.elt("FootnoteMark", labelTo, end),
          ]),
        );
      },
    },
  ],
  parseBlock: [
    {
      name: "FootnoteDefinition",
      leaf(_cx, leaf) {
        const match = FOOTNOTE_DEFINITION.exec(leaf.content);
        return match === null || match[1] === undefined
          ? null
          : new FootnoteDefinitionParser(match[0].length, match[1].length);
      },
      // A definition head starts its own block, so a run of definitions
      // written without blank lines between them stays a run of
      // definitions rather than folding into the first one's body.
      endLeaf(_cx, line) {
        return FOOTNOTE_DEFINITION.test(line.text.slice(line.pos));
      },
      before: "LinkReference",
    },
  ],
};

const taskPayloads: MarkdownConfig = {
  defineNodes: ["TaskDatePayload", "TaskLevelPayload"],
  parseInline: [
    {
      name: "TaskDatePayload",
      parse(cx, _next, pos) {
        if (
          !cx.slice(pos, pos + 2).startsWith("📅") ||
          (pos > cx.offset && !/\s/u.test(cx.slice(pos - 1, pos)))
        ) {
          return -1;
        }
        const match = TASK_DATE_PAYLOAD.exec(
          cx.slice(pos, Math.min(cx.end, pos + 16)),
        );
        return match === null
          ? -1
          : cx.addElement(
              cx.elt("TaskDatePayload", pos, pos + match[0].length),
            );
      },
    },
    {
      name: "TaskLevelPayload",
      parse(cx, _next, pos) {
        if (pos > cx.offset && !/\s/u.test(cx.slice(pos - 1, pos))) {
          return -1;
        }
        const level = TASK_LEVEL_PAYLOADS.find((candidate) =>
          cx.slice(pos, pos + candidate.length).startsWith(candidate),
        );
        return level === undefined
          ? -1
          : cx.addElement(cx.elt("TaskLevelPayload", pos, pos + level.length));
      },
    },
  ],
};

class ConfiguredTaskParser implements LeafBlockParser {
  constructor(private readonly markerLength: number) {}

  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt("Task", leaf.start, leaf.start + leaf.content.length, [
        cx.elt("TaskMarker", leaf.start, leaf.start + this.markerLength),
        ...cx.parser.parseInline(
          leaf.content.slice(this.markerLength),
          leaf.start + this.markerLength,
        ),
      ]),
    );
    return true;
  }
}

class UnknownTaskParser implements LeafBlockParser {
  constructor(private readonly markerLength: number) {}

  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt("UnknownTask", leaf.start, leaf.start + leaf.content.length, [
        cx.elt("UnknownTaskMarker", leaf.start, leaf.start + this.markerLength),
        ...cx.parser.parseInline(
          leaf.content.slice(this.markerLength),
          leaf.start + this.markerLength,
        ),
      ]),
    );
    return true;
  }
}

/** A TaskList parser restricted to the configured one-character symbols. */
export function taskListMarkdownExtension(
  statuses: readonly TaskStatus[],
): MarkdownConfig {
  const symbols = new Set(statuses.map((status) => status.symbol));
  return {
    defineNodes: [{ name: "UnknownTask", block: true }, "UnknownTaskMarker"],
    parseBlock: [
      {
        name: "TaskList",
        leaf(cx, leaf) {
          if (leaf.content[0] !== "[" || cx.parentType().name !== "ListItem") {
            return null;
          }
          const codePoint = leaf.content.codePointAt(1);
          if (codePoint === undefined) {
            return null;
          }
          const symbol = String.fromCodePoint(codePoint);
          const close = 1 + symbol.length;
          if (
            leaf.content[close] !== "]" ||
            !/[ \t]/u.test(leaf.content[close + 1] ?? "")
          ) {
            return null;
          }
          return symbols.has(symbol)
            ? new ConfiguredTaskParser(close + 1)
            : new UnknownTaskParser(close + 1);
        },
        after: "SetextHeading",
      },
    ],
  };
}

/**
 * Lezer reuses Markdown trees at block boundaries. A paragraph without a
 * blank line is one block, so editing any character in a multi-megabyte
 * paragraph otherwise reparses the entire block synchronously. Bound the
 * editor tree's paragraph blocks while leaving ordinary paragraphs intact.
 */
export const MAX_INCREMENTAL_PARAGRAPH_LENGTH = 4_096;
/** Maximum leading source scanned for a closed frontmatter block. */
export const FRONTMATTER_BLOCK_SCAN_LIMIT = 16_384;

const boundedParagraphs: MarkdownConfig = {
  parseBlock: [
    {
      name: "BoundedParagraph",
      endLeaf(_cx, _line, leaf) {
        return leaf.content.length >= MAX_INCREMENTAL_PARAGRAPH_LENGTH;
      },
    },
  ],
};

/**
 * The line that follows a document's opening `---` decides whether the
 * block is frontmatter at all. A YAML mapping entry, a sequence entry, a
 * comment, or an immediate closing delimiter opens frontmatter; anything
 * else means the `---` was a thematic break that happens to sit on the
 * first line, and the block parser leaves it to `HorizontalRule`.
 */
const FRONTMATTER_BODY_LINE = /^[ \t]*(?:#|-[ \t]|[^\s:#][^:]*:([ \t]|$))/;

function opensFrontmatter(nextLine: string): boolean {
  return (
    nextLine === "---" ||
    nextLine === "..." ||
    FRONTMATTER_BODY_LINE.test(nextLine)
  );
}

/**
 * The leading YAML frontmatter block as one opaque node, so `title: x`
 * lines followed by the closing `---` never read as a setext heading and
 * no inline construct is recognized inside the block. The block opens
 * with a line that is exactly `---` at document start, is followed by a
 * line that can belong to a YAML mapping, and closes at the next `---` or
 * `...` line. The editor scan is bounded; an opener without a nearby
 * close yields a thematic break followed by ordinary text instead of
 * making every subsequent edit reparse to the document end.
 */
const frontmatterBlock: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (
          cx.lineStart !== 0 ||
          line.text !== "---" ||
          !opensFrontmatter(cx.peekLine())
        ) {
          return false;
        }
        const lines = [line.text];
        let end = line.text.length;
        while (end < FRONTMATTER_BLOCK_SCAN_LIMIT && cx.nextLine()) {
          const currentLine = line.text as string;
          if (currentLine === "---" || currentLine === "...") {
            end = cx.lineStart + currentLine.length;
            cx.nextLine();
            cx.addElement(cx.elt("Frontmatter", 0, end));
            return true;
          }
          lines.push(currentLine);
          end = cx.lineStart + currentLine.length;
        }
        cx.nextLine();
        // The opener was never closed, so it was not frontmatter. The
        // delimiter keeps its thematic-break reading and the scanned body
        // stays one bounded paragraph rather than reparsing to the end.
        const openerLength = lines[0]?.length ?? 0;
        const bodyStart = openerLength + 1;
        cx.addElement(cx.elt("HorizontalRule", 0, openerLength));
        if (end > bodyStart) {
          cx.addElement(
            cx.elt(
              "Paragraph",
              bodyStart,
              end,
              cx.parser.parseInline(lines.slice(1).join("\n"), bodyStart),
            ),
          );
        }
        return true;
      },
    },
  ],
};

/**
 * The Obsidian additions, in a form `markdown({ extensions })` accepts.
 * The embed parser is registered before the wikilink parser so `![[` is
 * claimed as one embed rather than an image-plus-wikilink split.
 */
const obsidianMarkdownExtensionsWithoutTasks: MarkdownConfig[] = [
  boundedParagraphs,
  frontmatterBlock,
  wikilinks,
  tags,
  blockIds,
  callouts,
  footnotes,
  taskPayloads,
  mathMarkdownExtension,
];

export function obsidianMarkdownExtensionsFor(
  statuses: readonly TaskStatus[],
): MarkdownConfig[] {
  return [
    ...obsidianMarkdownExtensionsWithoutTasks,
    taskListMarkdownExtension(statuses),
  ];
}

export const obsidianMarkdownExtensions: MarkdownConfig[] =
  obsidianMarkdownExtensionsFor(DEFAULT_TASK_STATUSES);

const baseExtensions = [GFM, Subscript, Superscript, Emoji];

/**
 * The exact parser the editor's language support uses, standalone: the
 * CommonMark base plus the same extension set `@codemirror/lang-markdown`
 * layers into `markdownLanguage` (GFM, subscript, superscript, emoji),
 * plus the Obsidian additions. Snapshot tests and the conformance emitter
 * parse with this so their node vocabulary is the editor's.
 */
export const skribeumMarkdownParser = commonmark.configure([
  ...baseExtensions,
  ...obsidianMarkdownExtensions,
]);

/**
 * The same parser without the frontmatter block: the conformance emitter
 * uses it for documents whose leading `---` is never closed, which the
 * syntax specification rules to not be frontmatter at all.
 */
export const skribeumMarkdownParserWithoutFrontmatter = commonmark.configure([
  ...baseExtensions,
  ...obsidianMarkdownExtensions.filter(
    (extension) => extension !== frontmatterBlock,
  ),
]);
