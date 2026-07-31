// Obsidian constructs the stock CommonMark+GFM parser lacks: wikilinks,
// embeds, tags, block identifiers and callout marks, added through
// @lezer/markdown MarkdownConfig extensions. These node names are the sole
// vocabulary the decoration table speaks, and the same extended parser
// feeds the two-parser conformance emitter, so this module is the single
// place the webview's Obsidian syntax lives.

import {
  parser as commonmark,
  type Element,
  Emoji,
  GFM,
  type InlineContext,
  type MarkdownConfig,
  Subscript,
  Superscript,
} from "@lezer/markdown";

const CHAR_EXCLAMATION = 33;
const CHAR_HASH = 35;
const CHAR_BRACKET_OPEN = 91;
const CHAR_BRACKET_CLOSE = 93;
const CHAR_CARET = 94;
const CHAR_PIPE = 124;
const CHAR_NEWLINE = 10;

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
 * The leading YAML frontmatter block as one opaque node, so `title: x`
 * lines followed by the closing `---` never read as a setext heading and
 * no inline construct is recognized inside the block. The block opens
 * with a line that is exactly `---` at document start and closes at the
 * next `---` or `...` line. An unterminated opener consumes the rest of
 * the document as frontmatter; the conformance emitter applies the
 * specification's stricter unterminated-is-not-frontmatter rule by
 * choosing a parser without this extension for such documents.
 */
const frontmatterBlock: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text !== "---") {
          return false;
        }
        while (cx.nextLine()) {
          if (line.text === "---" || line.text === "...") {
            const end = cx.lineStart + line.text.length;
            cx.nextLine();
            cx.addElement(cx.elt("Frontmatter", 0, end));
            return true;
          }
        }
        cx.addElement(cx.elt("Frontmatter", 0, cx.prevLineEnd()));
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
export const obsidianMarkdownExtensions: MarkdownConfig[] = [
  frontmatterBlock,
  wikilinks,
  tags,
  blockIds,
  callouts,
];

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
