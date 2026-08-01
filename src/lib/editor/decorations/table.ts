// The decoration mapping table: every Tier 1 construct's presentation is
// one data row from a Lezer markdown node name to a mark, replacement,
// line or widget decoration, with a cursor-reveal policy per row (decision
// 11; the data-driven shape is decision 34's exception). The engine in
// `engine.ts` interprets rows; nothing outside this file decides what a
// construct looks like. `docs/decoration-rules.md` mirrors the reveal
// column row for row, and a test keeps the two in lockstep.

/** When a hidden or replaced range re-appears as plain source text. */
export type RevealPolicy = "cursor-inside" | "cursor-line" | "never";

/** Widgets the engine knows how to build. */
export type WidgetName =
  | "task-checkbox"
  | "math-inline"
  | "math-block"
  | "mermaid-diagram"
  | "table-row"
  | "table-separator"
  | "embed"
  | "code-copy"
  | "callout-icon";

export type Presentation =
  /** A styled span over the node's text. */
  | {
      present: "mark";
      class: string;
      attributes?: Readonly<Record<string, string>>;
    }
  /** The node's text is removed from the rendered line. */
  | { present: "hide" }
  /** A class on every document line the node covers. */
  | { present: "line"; class: string }
  /** The node's text is replaced by, or receives, a rendered widget. */
  | {
      present: "widget";
      widget: WidgetName;
      /** `before` inserts without replacing source, for overlay controls. */
      place?: "replace" | "before";
    };

/**
 * Named engine behaviors a row may reference for context-dependent
 * attributes. The table stays data; these are the documented builtins the
 * engine implements: `wikilink-resolution` adds `data-resolved`,
 * `callout-type` adds `data-callout` (and only fires inside a Blockquote
 * headed by a callout mark), `code-language` adds `data-language`.
 */
export type DynamicAttribute =
  | "wikilink-resolution"
  | "callout-type"
  | "rich-callout"
  | "code-language"
  | "mermaid-block";

export type DecorationRule = {
  /** Lezer markdown node name this row decorates. */
  node: string;
  /**
   * For hidden markers: also hide one adjacent space (after the marker
   * when one follows, else before it), so `# Heading` renders without the
   * leading gap while the source text is untouched.
   */
  extendThroughSpace?: boolean;
  /** Only nodes whose direct parent is one of these names. */
  parent?: readonly string[];
  /** Only nodes whose direct parent is none of these names. */
  notParent?: readonly string[];
  /** Only nodes with an ancestor of this name anywhere above. */
  ancestor?: string;
  /** Only nodes with a sibling of this name under the same parent. */
  withSibling?: string;
  /** Only nodes without a sibling of this name under the same parent. */
  withoutSibling?: string;
  /** Only fenced code whose first info-string token matches this value. */
  codeInfo?: string;
  presentation: Presentation;
  reveal: RevealPolicy;
  /** Override the construct range selected by a cursor reveal. */
  revealScope?: "node" | "parent";
  /** Reveal this construct as plain source, including nested constructs. */
  revealDescendants?: boolean;
  dynamic?: DynamicAttribute;
};

const ATX_HEADINGS = [
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
] as const;

const SETEXT_HEADINGS = ["SetextHeading1", "SetextHeading2"] as const;

const headingRows: DecorationRule[] = [
  ...ATX_HEADINGS.map((node, index) => ({
    node,
    presentation: {
      present: "line",
      class: `cm-skr-heading cm-skr-heading-${index + 1}`,
    } satisfies Presentation,
    reveal: "never" as const,
  })),
  ...SETEXT_HEADINGS.map((node, index) => ({
    node,
    presentation: {
      present: "line",
      class: `cm-skr-heading cm-skr-heading-${index + 1}`,
    } satisfies Presentation,
    reveal: "never" as const,
  })),
  {
    node: "HeaderMark",
    parent: ATX_HEADINGS,
    extendThroughSpace: true,
    presentation: { present: "hide" },
    reveal: "cursor-line",
  },
  {
    node: "HeaderMark",
    parent: SETEXT_HEADINGS,
    presentation: { present: "mark", class: "cm-skr-setext-underline" },
    reveal: "never",
  },
];

const emphasisRows: DecorationRule[] = [
  {
    node: "Emphasis",
    presentation: { present: "mark", class: "cm-skr-emphasis" },
    reveal: "never",
  },
  {
    node: "StrongEmphasis",
    presentation: { present: "mark", class: "cm-skr-strong" },
    reveal: "never",
  },
  {
    node: "EmphasisMark",
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
  {
    node: "Strikethrough",
    presentation: { present: "mark", class: "cm-skr-strikethrough" },
    reveal: "never",
  },
  {
    node: "StrikethroughMark",
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
];

const linkRows: DecorationRule[] = [
  {
    node: "Link",
    presentation: { present: "mark", class: "cm-skr-link" },
    reveal: "never",
  },
  {
    node: "Image",
    presentation: { present: "mark", class: "cm-skr-link" },
    reveal: "never",
  },
  {
    node: "LinkMark",
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
  {
    node: "URL",
    parent: ["Link", "Image"],
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
  {
    node: "URL",
    notParent: ["Link", "Image"],
    presentation: { present: "mark", class: "cm-skr-url" },
    reveal: "never",
  },
  {
    node: "LinkTitle",
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
  {
    node: "LinkLabel",
    presentation: { present: "mark", class: "cm-skr-link-label" },
    reveal: "never",
  },
];

const wikilinkRows: DecorationRule[] = [
  {
    node: "Wikilink",
    presentation: { present: "mark", class: "cm-skr-wikilink" },
    reveal: "never",
    dynamic: "wikilink-resolution",
  },
  {
    node: "WikilinkMark",
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
  {
    node: "WikilinkTarget",
    withSibling: "WikilinkAlias",
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
  {
    node: "WikilinkTarget",
    withoutSibling: "WikilinkAlias",
    presentation: { present: "mark", class: "cm-skr-wikilink-target" },
    reveal: "never",
  },
  {
    node: "WikilinkAlias",
    presentation: { present: "mark", class: "cm-skr-wikilink-alias" },
    reveal: "never",
  },
  {
    node: "Embed",
    presentation: { present: "widget", widget: "embed" },
    reveal: "cursor-inside",
  },
  {
    node: "EmbedMark",
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
];

const tableRows: DecorationRule[] = [
  {
    node: "TableHeader",
    presentation: { present: "widget", widget: "table-row" },
    reveal: "cursor-inside",
  },
  {
    node: "TableDelimiter",
    parent: ["Table"],
    presentation: { present: "widget", widget: "table-separator" },
    reveal: "cursor-inside",
  },
  {
    node: "TableRow",
    presentation: { present: "widget", widget: "table-row" },
    reveal: "cursor-inside",
  },
];

const listRows: DecorationRule[] = [
  {
    node: "ListMark",
    presentation: { present: "mark", class: "cm-skr-list-mark" },
    reveal: "never",
  },
  {
    node: "TaskMarker",
    presentation: { present: "widget", widget: "task-checkbox" },
    reveal: "cursor-inside",
  },
];

const mathRows: DecorationRule[] = [
  {
    node: "InlineMath",
    presentation: { present: "widget", widget: "math-inline" },
    reveal: "cursor-inside",
  },
  {
    node: "BlockMath",
    presentation: { present: "widget", widget: "math-block" },
    reveal: "cursor-inside",
  },
];

const codeRows: DecorationRule[] = [
  {
    node: "InlineCode",
    presentation: { present: "mark", class: "cm-skr-inline-code" },
    reveal: "never",
  },
  {
    node: "CodeMark",
    parent: ["InlineCode"],
    presentation: { present: "hide" },
    reveal: "cursor-inside",
  },
  {
    node: "CodeMark",
    parent: ["FencedCode"],
    presentation: { present: "mark", class: "cm-skr-code-fence" },
    reveal: "cursor-inside",
  },
  {
    node: "FencedCode",
    presentation: { present: "line", class: "cm-skr-code-block" },
    reveal: "never",
  },
  {
    node: "CodeBlock",
    presentation: { present: "line", class: "cm-skr-code-block" },
    reveal: "never",
  },
  {
    node: "CodeInfo",
    presentation: { present: "mark", class: "cm-skr-code-info" },
    reveal: "cursor-inside",
    dynamic: "code-language",
  },
  {
    node: "FencedCode",
    presentation: {
      present: "widget",
      widget: "code-copy",
      place: "before",
    },
    reveal: "never",
  },
  {
    node: "FencedCode",
    codeInfo: "mermaid",
    presentation: { present: "widget", widget: "mermaid-diagram" },
    reveal: "cursor-inside",
    dynamic: "mermaid-block",
  },
];

const quoteRows: DecorationRule[] = [
  {
    node: "Blockquote",
    presentation: { present: "line", class: "cm-skr-rich-callout" },
    reveal: "cursor-inside",
    revealScope: "node",
    revealDescendants: true,
    dynamic: "rich-callout",
  },
  {
    node: "Blockquote",
    presentation: { present: "line", class: "cm-skr-blockquote" },
    reveal: "never",
    dynamic: "callout-type",
  },
  {
    node: "QuoteMark",
    ancestor: "Blockquote",
    presentation: { present: "hide" },
    reveal: "never",
    dynamic: "callout-type",
  },
  {
    node: "QuoteMark",
    presentation: { present: "mark", class: "cm-skr-quote-mark" },
    reveal: "never",
  },
  {
    node: "CalloutMark",
    ancestor: "Blockquote",
    presentation: { present: "hide" },
    reveal: "never",
    dynamic: "callout-type",
  },
  {
    node: "CalloutMark",
    ancestor: "Blockquote",
    presentation: { present: "mark", class: "cm-skr-callout-mark" },
    reveal: "never",
    dynamic: "callout-type",
  },
  {
    node: "CalloutMark",
    ancestor: "Blockquote",
    presentation: {
      present: "widget",
      widget: "callout-icon",
      place: "before",
    },
    reveal: "never",
    dynamic: "callout-type",
  },
  {
    node: "CalloutType",
    ancestor: "Blockquote",
    presentation: { present: "mark", class: "cm-skr-callout-type" },
    reveal: "never",
  },
];

const inlineRows: DecorationRule[] = [
  {
    node: "HashTag",
    presentation: { present: "mark", class: "cm-skr-tag" },
    reveal: "never",
  },
  {
    node: "BlockId",
    presentation: { present: "mark", class: "cm-skr-block-id" },
    reveal: "never",
  },
  {
    node: "Frontmatter",
    presentation: { present: "line", class: "cm-skr-frontmatter" },
    reveal: "never",
  },
];

/** The Tier 1 decoration table, in document-feature order. */
export const DECORATION_TABLE: readonly DecorationRule[] = [
  ...headingRows,
  ...emphasisRows,
  ...linkRows,
  ...wikilinkRows,
  ...tableRows,
  ...listRows,
  ...mathRows,
  ...codeRows,
  ...quoteRows,
  ...inlineRows,
];
